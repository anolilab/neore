/**
 * Device execution — the server side of the relay: which devices a run may
 * reach, creating and signing a call, the state the waiting tool polls, and
 * the housekeeping sweep. Called by the tool proxy (`chat/lib/device-tools.ts`).
 */
import { v } from "lunorash/server";

import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import { decryptKey } from "../lib/encryption";
import { checkRateLimit } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { DEVICE_CALL_DEADLINE_MS, DEVICE_CALL_RETENTION_MS, MAX_DEVICE_INPUT_BYTES, MAX_OPEN_CALLS_PER_DEVICE } from "./lib/constants";
import { signDevicePayload, utf8Length } from "./lib/signing";
import { isDeviceOnline, isTerminalCallStatus, OPEN_CALL_STATUSES } from "./lib/state";
import { vDeviceCallStatus, vDeviceManifestTool, vDeviceTaintSource } from "./validators";

type ThreadRow = Pick<Doc<"threads">, "deleted" | "externalThreadId" | "groupChat" | "isPublic" | "userId">;

/**
 * Whether a thread may reach its owner's devices at all: the run's user owns it
 * and nobody else's text can be in its context — not shared, not public, not a
 * group chat, not a messenger conversation. Pure; pinned by `internal.test.ts`.
 */
export const isDeviceEligibleThread = (thread: ThreadRow | null, userId: string, hasGrants: boolean): boolean =>
    thread !== null &&
    thread.deleted !== true &&
    thread.userId === userId &&
    thread.isPublic !== true &&
    thread.groupChat === undefined &&
    thread.externalThreadId === undefined &&
    !hasGrants;

const loadEligibleThread = async (ctx: Pick<QueryCtx, "db">, threadId: Doc<"threads">["_id"], userId: string): Promise<Doc<"threads"> | null> => {
    const thread = await ctx.db.get(threadId);
    const grant = await ctx.db.threadAccess.findFirst({ where: { threadId } });

    return isDeviceEligibleThread(thread, userId, grant !== null) ? thread : null;
};

/**
 * The devices an interactive run in this thread may call, with their verified
 * manifests — or `null` when the thread is not eligible. Offline devices,
 * unpaired rows and empty manifests are left out, so the model never sees a
 * tool it cannot reach.
 */
export const getDeviceToolContext = internalQuery
    // `now` from the caller (an action), so the query stays deterministic.
    .input({ now: v.number(), threadId: v.id("threads"), userId: v.string() })
    .output(
        v.union(
            v.null(),
            v.object({
                devices: v.array(v.object({ deviceId: v.string(), name: v.string(), tools: v.array(vDeviceManifestTool) })),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        if (!(await loadEligibleThread(ctx, args.threadId, args.userId))) {
            return null;
        }

        const { now } = args;
        const { page } = await ctx.db.devices.findMany({ orderBy: [{ createdAt: "asc" }], where: { userId: args.userId } });

        return {
            devices: page
                .filter((device) => device.encryptedSecret !== undefined && (device.manifest?.length ?? 0) > 0 && isDeviceOnline(device, now))
                .map((device) => {
                    return { deviceId: device._id as string, name: device.name, tools: device.manifest ?? [] };
                }),
        };
    });

const vCreateResult = v.union(
    v.object({ callId: v.string() }),
    v.object({ error: v.union(v.literal("busy"), v.literal("ineligible"), v.literal("input_too_large"), v.literal("offline"), v.literal("rate_limited")) }),
);

/**
 * Creates and signs one call. Every gate the tool set was built under is
 * re-checked here, at call time: the thread is still eligible, the device is
 * still paired, online and advertising the tool, it holds fewer than
 * {@link MAX_OPEN_CALLS_PER_DEVICE} open calls, and the user is under the
 * `devices/call` rate limit.
 */
export const createDeviceCall = internalMutation
    .input({
        deviceId: v.id("devices"),
        input: v.string(),
        taintedBy: v.array(vDeviceTaintSource),
        threadId: v.id("threads"),
        toolCallId: v.optional(v.string().max(MAX_LENGTH.short)),
        toolName: v.string(),
        userId: v.string(),
    })
    .output(vCreateResult)
    .mutation(async ({ args, ctx }) => {
        const { deviceId, threadId, toolName, userId } = args;

        if (utf8Length(args.input) > MAX_DEVICE_INPUT_BYTES) {
            return { error: "input_too_large" as const };
        }

        const thread = await loadEligibleThread(ctx, threadId, userId);
        const device = await ctx.db.devices.findFirst({ where: { _id: deviceId, userId } });

        if (!thread || !device?.encryptedSecret || !device.manifest?.some((tool) => tool.name === toolName)) {
            return { error: "ineligible" as const };
        }

        const now = ctx.now;

        if (!isDeviceOnline(device, now)) {
            return { error: "offline" as const };
        }

        let open = 0;

        for (const status of OPEN_CALL_STATUSES) {
            const { page } = await ctx.db.deviceCalls.findMany({ limit: MAX_OPEN_CALLS_PER_DEVICE, where: { deviceId, status } });

            open += page.length;
        }

        if (open >= MAX_OPEN_CALLS_PER_DEVICE) {
            return { error: "busy" as const };
        }

        const limited = await checkRateLimit(ctx, "devices/call:free", { key: userId });

        if (!limited.ok) {
            return { error: "rate_limited" as const };
        }

        const deadline = now + DEVICE_CALL_DEADLINE_MS;
        const callId = await ctx.db.insert("deviceCalls", {
            createdAt: now,
            deadline,
            deviceId,
            deviceName: device.name,
            envelope: "",
            input: args.input,
            signature: "",
            status: "pending",
            taintedBy: args.taintedBy,
            threadId,
            toolName,
            userId,
            ...(args.toolCallId !== undefined && { toolCallId: args.toolCallId }),
        });
        const envelope = JSON.stringify({
            callId,
            deviceId,
            expiresAt: deadline,
            input: JSON.parse(args.input) as unknown,
            issuedAt: now,
            kind: "call",
            nonce: crypto.randomUUID(),
            taintedBy: args.taintedBy,
            threadId,
            threadTitle: (thread.title ?? "").slice(0, 200),
            tool: toolName,
            v: 1,
        });
        const secret = await decryptKey(device.encryptedSecret, "device-secrets");

        await ctx.db.patch(callId, { envelope, signature: await signDevicePayload(secret, "call", envelope) });

        return { callId: callId as string };
    });

const vCallState = v.union(
    v.null(),
    v.object({
        createdAt: v.number(),
        deadline: v.number(),
        error: v.optional(v.string()),
        exitCode: v.optional(v.number()),
        output: v.optional(v.string()),
        status: vDeviceCallStatus,
        truncated: v.optional(v.boolean()),
    }),
);

const toCallState = (call: Doc<"deviceCalls">) => {
    return {
        createdAt: call.createdAt,
        deadline: call.deadline,
        status: call.status,
        ...(call.error !== undefined && { error: call.error }),
        ...(call.exitCode !== undefined && { exitCode: call.exitCode }),
        ...(call.output !== undefined && { output: call.output }),
        ...(call.truncated !== undefined && { truncated: call.truncated }),
    };
};

/** What the waiting tool polls. */
export const getDeviceCallState = internalQuery
    .input({ callId: v.id("deviceCalls") })
    .output(vCallState)
    .query(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId } });

        return call ? toCallState(call) : null;
    });

/**
 * The tool gave up (offline, deadline, the user pressed Stop). Only an OPEN call
 * moves; one the device finished in the meantime is returned as it is, so the
 * caller always acts on the final state.
 */
export const expireDeviceCall = internalMutation
    .input({ callId: v.id("deviceCalls"), reason: v.string() })
    .output(vCallState)
    .mutation(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId } });

        if (!call) {
            return null;
        }

        if (isTerminalCallStatus(call.status)) {
            return toCallState(call);
        }

        const changes = { completedAt: ctx.now, error: args.reason.slice(0, 500), status: "expired" as const };

        await ctx.db.patch(call._id, changes);

        return toCallState({ ...call, ...changes });
    });

const SWEEP_BATCH = 200;

/**
 * Per-shard housekeeping (`lib/shard-housekeeping.ts`): expires open calls a
 * killed run left past their deadline, and prunes audit rows older than 30 days.
 */
export const sweepDeviceCalls = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const now = ctx.now;

        for (const status of OPEN_CALL_STATUSES) {
            const { page } = await ctx.db.deviceCalls.findMany({ limit: SWEEP_BATCH, where: { deadline: { lt: now }, status } });

            await Promise.all(page.map(async (call) => await ctx.db.patch(call._id, { completedAt: now, error: "Timed out", status: "expired" })));
        }

        const { page: old } = await ctx.db.deviceCalls.findMany({
            limit: SWEEP_BATCH,
            orderBy: [{ createdAt: "asc" }],
            where: { createdAt: { lt: now - DEVICE_CALL_RETENTION_MS } },
        });

        await Promise.all(old.map(async (call) => await ctx.db.delete(call._id)));

        return null;
    });
