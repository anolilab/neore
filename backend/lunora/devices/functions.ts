/**
 * Device execution — the procedures the web app calls
 * (`docs/plans/device-execution.md`). A device is one paired install of the
 * desktop shell; every procedure here is its OWNER's alone, and every
 * `deviceId` from arguments is compared against the caller.
 *
 * The page is a dumb pipe: what it relays from the device (manifest, results)
 * carries the device's HMAC and is verified here, and what it relays to the
 * device (call envelopes) carries ours. Nothing here can approve a call — that
 * happens in the shell's local window.
 */
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { decryptKey, encryptKey } from "../lib/encryption";
import { DEVICE_CLAIM_WINDOW_MS, DEVICE_SIGNATURE_WINDOW_MS, MAX_DEVICE_OUTPUT_BYTES, MAX_DEVICES_PER_USER, MAX_MANIFEST_BYTES } from "./lib/constants";
import { parseManifestTools } from "./lib/manifest";
import { expireOpenCalls, isForwardPhase } from "./lib/state";
import { capUtf8, generateDeviceSecret, isFreshTimestamp, parseSignedPayload, verifyDevicePayload } from "./lib/signing";
import { vDeviceCallView, vDevicePlatform, vDeviceView, vDeviceCallStatusView } from "./validators";

const vDeviceName = v.string().check((value) => value.trim().length > 0 && value.length <= 80, { message: "Name must be 1-80 characters" });

/** Results carry at most the output cap plus JSON overhead; the backend re-caps anyway. */
const MAX_RESULT_PAYLOAD_CHARS = MAX_DEVICE_OUTPUT_BYTES * 2 + 8192;

// A payload the page relays is bounded before any crypto runs; its signature is a hex HMAC.
const vManifestPayload = v.string().check((value) => value.length > 0 && value.length <= MAX_MANIFEST_BYTES, { message: "Payload too large" });
const vResultPayload = v.string().check((value) => value.length > 0 && value.length <= MAX_RESULT_PAYLOAD_CHARS, { message: "Payload too large" });
const HEX_SIGNATURE = /^[0-9a-f]{64}$/u;
const vSignature = v.string().check((value) => HEX_SIGNATURE.test(value), { message: "Invalid signature" });

/** A progress report is a few short fields; anything longer is not one. */
const vProgressPayload = v.string().check((value) => value.length > 0 && value.length <= 1024, { message: "Payload too large" });
const PHASES: ReadonlySet<string> = new Set(["prompting", "running"]);

const RESULT_STATUSES: ReadonlySet<string> = new Set(["completed", "denied", "failed"]);
const DECISIONS: ReadonlySet<string> = new Set(["always", "denied", "once", "rule", "timeout"]);
const OUTPUT_PREVIEW_CHARS = 4000;

/** The caller's device, or FORBIDDEN — a stranger's id reads exactly like a missing one. */
const requireOwnDevice = async (ctx: Pick<MutationCtx, "db">, deviceId: Id<"devices">, userId: string): Promise<Doc<"devices">> => {
    const device = await ctx.db.devices.findFirst({ where: { _id: deviceId, userId } });

    if (!device) {
        throw new LunoraError("NOT_FOUND", "Device not found");
    }

    return device;
};

const deviceSecret = async (device: Doc<"devices">): Promise<string> => {
    if (device.encryptedSecret === undefined) {
        throw new LunoraError("FORBIDDEN", "Device is not paired");
    }

    return await decryptKey(device.encryptedSecret, "device-secrets");
};

/**
 * Pairs a new device. Returns its secret ONCE: the page hands it straight to
 * the shell (`device_pair`), which stores it only after a local confirmation
 * click. Guests and impersonating admins cannot pair — a device runs code as
 * the real person at the keyboard.
 */
export const registerDevice = authMutation
    .use(rateLimit("devices/register"))
    .input({ name: vDeviceName, platform: vDevicePlatform })
    .output(v.object({ deviceId: v.string(), secret: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const { impersonatedBy, userId } = ctx.user;

        if (impersonatedBy) {
            throw new LunoraError("FORBIDDEN", "A device cannot be paired while impersonating");
        }

        const account = await ctx.db.user.findFirst({ where: { _id: ctx.db.asId("user", userId) } });

        if (!account || account.isAnonymous === true) {
            throw new LunoraError("FORBIDDEN", "Pairing a device requires an account");
        }

        if (await isAccountDeletionUnderway(ctx, userId)) {
            throw new LunoraError("FORBIDDEN", "This account is being deleted");
        }

        const { page: existing } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER + 1, where: { userId } });

        if (existing.length >= MAX_DEVICES_PER_USER) {
            throw new LunoraError("BAD_REQUEST", `At most ${String(MAX_DEVICES_PER_USER)} devices can be paired. Remove one first.`);
        }

        const secret = generateDeviceSecret();
        const deviceId = await ctx.db.insert("devices", {
            createdAt: ctx.now,
            encryptedSecret: await encryptKey(secret, "device-secrets"),
            name: args.name.trim(),
            platform: args.platform,
            userId,
        });

        ctx.log.event("devices.register_device", { platform: args.platform });

        return { deviceId: deviceId as string, secret };
    });

/** The caller's paired devices. Online state is the client's to derive from `lastSeenAt` (`DEVICE_ONLINE_WINDOW_MS`). */
export const listDevices = authQuery
    .input({})
    .output(v.array(vDeviceView))
    .query(async ({ ctx }) => {
        const { page } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER, orderBy: [{ createdAt: "asc" }], where: { userId: ctx.user.userId } });

        return page.map((device) => {
            return {
                _id: device._id as string,
                createdAt: device.createdAt,
                name: device.name,
                platform: device.platform,
                toolNames: (device.manifest ?? []).map((tool) => tool.name),
                ...(device.lastSeenAt !== undefined && { lastSeenAt: device.lastSeenAt }),
            };
        });
    });

export const renameDevice = authMutation
    .use(rateLimit("devices/manage"))
    .input({ deviceId: v.id("devices"), name: vDeviceName })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const device = await requireOwnDevice(ctx, args.deviceId, ctx.user.userId);

        await ctx.db.patch(device._id, { name: args.name.trim() });

        ctx.log.event("devices.rename_device", { renamed: true });

        return null;
    });

/**
 * Unpairs a device from the web — the way out for a lost laptop. The row (and
 * with it the secret) is deleted, so nothing is ever signed for it again; its
 * audit rows stay, carrying the device's name.
 */
export const revokeDevice = authMutation
    .use(rateLimit("devices/manage"))
    .input({ deviceId: v.id("devices") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const device = await requireOwnDevice(ctx, args.deviceId, ctx.user.userId);

        await expireOpenCalls(ctx, device._id, "The device was removed");
        await ctx.db.delete(device._id);

        ctx.log.event("devices.revoke_device", { revoked: true });

        return null;
    });

/**
 * The shell's page beats every 30 s while open. `paired: false` tells it this
 * device is gone (revoked elsewhere), so it offers pairing again.
 */
export const heartbeatDevice = authMutation
    .use(rateLimit("devices/heartbeat"))
    .input({ deviceId: v.id("devices") })
    .output(v.object({ paired: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId: ctx.user.userId } });

        if (!device) {
            return { paired: false };
        }

        await ctx.db.patch(device._id, { lastSeenAt: ctx.now });

        ctx.log.event("devices.heartbeat_device", { paired: true });

        return { paired: true };
    });

/**
 * Stores the device's tool list. The manifest is SIGNED by the device's Rust
 * core, must be fresh and newer than the stored one (no rollback to an older
 * tool set), and is re-validated (`lib/manifest.ts`).
 */
export const updateDeviceManifest = authMutation
    .use(rateLimit("devices/manifest"))
    .input({ deviceId: v.id("devices"), payload: vManifestPayload, signature: vSignature })
    .output(v.object({ toolCount: v.number() }))
    .mutation(async ({ args, ctx }) => {
        const device = await requireOwnDevice(ctx, args.deviceId, ctx.user.userId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "manifest", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Manifest signature is invalid");
        }

        const now = ctx.now;
        const manifest = parseSignedPayload(args.payload, "manifest", device._id as string);
        const issuedAt = manifest?.issuedAt;

        if (
            !manifest ||
            !isFreshTimestamp(issuedAt, now, DEVICE_SIGNATURE_WINDOW_MS) ||
            (device.manifestIssuedAt !== undefined && issuedAt <= device.manifestIssuedAt)
        ) {
            throw new LunoraError("BAD_REQUEST", "Manifest is stale or malformed");
        }

        const tools = parseManifestTools(manifest.tools);

        if (!tools) {
            throw new LunoraError("BAD_REQUEST", "Manifest tools are invalid");
        }

        await ctx.db.patch(device._id, { lastSeenAt: now, manifest: tools, manifestIssuedAt: issuedAt });

        ctx.log.event("devices.update_device_manifest", { toolCount: tools.length });

        return { toolCount: tools.length };
    });

/**
 * Calls waiting for this device — the relay's live query. The page forwards
 * each envelope to the shell, which verifies our signature before anything else.
 */
export const listPendingDeviceCalls = authQuery
    .input({ deviceId: v.id("devices") })
    .output(v.array(v.object({ callId: v.string(), envelope: v.string(), signature: v.string() })))
    .query(async ({ args, ctx }) => {
        const { page } = await ctx.db.deviceCalls.findMany({
            limit: 10,
            orderBy: [{ createdAt: "asc" }],
            where: { deviceId: args.deviceId, status: "pending", userId: ctx.user.userId },
        });

        return page.map((call) => {
            return { callId: call._id as string, envelope: call.envelope, signature: call.signature };
        });
    });

/**
 * Claim-once: the first relay to claim a call runs it; a second window, a
 * stale page or a late claim past the claim window gets `claimed: false`.
 */
export const claimDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), deviceId: v.id("devices") })
    .output(v.object({ claimed: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: args.deviceId, userId } });
        const now = ctx.now;

        if (call?.status !== "pending" || now - call.createdAt > DEVICE_CLAIM_WINDOW_MS) {
            return { claimed: false };
        }

        await requireOwnDevice(ctx, args.deviceId, userId);
        await ctx.db.patch(call._id, { claimedAt: now, status: "claimed" });

        ctx.log.event("devices.claim_device_call", { claimed: true });

        return { claimed: true };
    });

/**
 * Records a device's SIGNED result. A terminal call is never rewritten, so a
 * replayed result for a finished call is ignored (`accepted: false`).
 */
export const completeDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), deviceId: v.id("devices"), payload: vResultPayload, signature: vSignature })
    .output(v.object({ accepted: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await requireOwnDevice(ctx, args.deviceId, userId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "result", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Result signature is invalid");
        }

        const result = parseSignedPayload(args.payload, "result", device._id as string);

        if (result?.callId !== args.callId || typeof result.status !== "string" || !RESULT_STATUSES.has(result.status)) {
            throw new LunoraError("BAD_REQUEST", "Result is malformed");
        }

        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: device._id, userId } });

        if (call?.status !== "claimed") {
            return { accepted: false };
        }

        const now = ctx.now;
        const output = typeof result.output === "string" ? capUtf8(result.output, MAX_DEVICE_OUTPUT_BYTES) : undefined;
        const error = typeof result.error === "string" ? result.error.slice(0, 1000) : undefined;
        const decision = typeof result.decision === "string" && DECISIONS.has(result.decision) ? result.decision : undefined;
        const exitCode = typeof result.exitCode === "number" && Number.isSafeInteger(result.exitCode) ? result.exitCode : undefined;

        await ctx.db.patch(call._id, {
            completedAt: now,
            status: result.status as "completed" | "denied" | "failed",
            ...(output && { output: output.text, truncated: output.truncated || result.truncated === true }),
            ...(error !== undefined && { error }),
            ...(decision !== undefined && { decision }),
            ...(exitCode !== undefined && { exitCode }),
        });

        ctx.log.event("devices.complete_device_call", { accepted: true, status: result.status });

        return { accepted: true };
    });

/**
 * Records where a claimed call is on the device — the approval window is
 * showing it (`prompting`), or it is running — so the chat can say so. SIGNED
 * by the device like a result (domain `progress`), fresh, for this call, and
 * forward-only: a replayed or reordered report can never move a call back, and
 * no report can finish one. Display only — nothing reads `phase` to decide.
 */
export const reportDeviceCallProgress = authMutation
    .use(rateLimit("devices/relay"))
    .input({ callId: v.id("deviceCalls"), deviceId: v.id("devices"), payload: vProgressPayload, signature: vSignature })
    .output(v.object({ accepted: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        const device = await requireOwnDevice(ctx, args.deviceId, userId);
        const secret = await deviceSecret(device);

        if (!(await verifyDevicePayload(secret, "progress", args.payload, args.signature))) {
            throw new LunoraError("FORBIDDEN", "Progress signature is invalid");
        }

        const now = ctx.now;
        const report = parseSignedPayload(args.payload, "progress", device._id as string);
        const phase = report?.phase;

        if (
            report?.callId !== args.callId ||
            typeof phase !== "string" ||
            !PHASES.has(phase) ||
            !isFreshTimestamp(report.issuedAt, now, DEVICE_SIGNATURE_WINDOW_MS)
        ) {
            throw new LunoraError("BAD_REQUEST", "Progress report is malformed");
        }

        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: device._id, userId } });
        const next = phase as "prompting" | "running";

        if (call?.status !== "claimed" || !isForwardPhase(call.phase, next)) {
            return { accepted: false };
        }

        await ctx.db.patch(call._id, { phase: next, phaseAt: now });

        ctx.log.event("devices.report_device_call_progress", { phase: next });

        return { accepted: true };
    });

/**
 * The shell refused a claimed call's envelope before running anything (not
 * paired any more, expired, not signed for it) and so has no signed result to
 * send. Fails the call at once instead of leaving the agent waiting for the
 * deadline. Unsigned on purpose: all it can do is stop the caller's OWN call.
 */
export const releaseDeviceCall = authMutation
    .use(rateLimit("devices/relay"))
    .input({
        callId: v.id("deviceCalls"),
        deviceId: v.id("devices"),
        reason: v.string().check((value) => value.length <= 500, { message: "Reason too long" }),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { _id: args.callId, deviceId: args.deviceId, userId: ctx.user.userId } });

        if (call?.status === "claimed") {
            await ctx.db.patch(call._id, { completedAt: ctx.now, error: `The device refused the request: ${args.reason}`, status: "failed" });
        }

        ctx.log.event("devices.release_device_call", { released: call?.status === "claimed" });

        return null;
    });

/** The audit list: the caller's recent device calls, newest first, optionally for one device. */
export const listDeviceCalls = authQuery
    .input({
        deviceId: v.optional(v.id("devices")),
        limit: v.optional(v.number().check((value) => Number.isSafeInteger(value) && value >= 1 && value <= 100, { message: "limit must be 1-100" })),
    })
    .output(v.array(vDeviceCallView))
    .query(async ({ args, ctx }) => {
        const { page } = await ctx.db.deviceCalls.findMany({
            limit: args.limit ?? 50,
            orderBy: [{ createdAt: "desc" }],
            where: { userId: ctx.user.userId, ...(args.deviceId !== undefined && { deviceId: args.deviceId }) },
        });

        return page.map((call) => {
            return {
                _id: call._id as string,
                createdAt: call.createdAt,
                deviceId: call.deviceId as string,
                deviceName: call.deviceName,
                input: call.input.slice(0, OUTPUT_PREVIEW_CHARS),
                status: call.status,
                taintedBy: call.taintedBy,
                threadId: call.threadId as string,
                toolName: call.toolName,
                ...(call.completedAt !== undefined && { completedAt: call.completedAt }),
                ...(call.decision !== undefined && { decision: call.decision }),
                ...(call.error !== undefined && { error: call.error }),
                ...(call.exitCode !== undefined && { exitCode: call.exitCode }),
                ...(call.output !== undefined && { output: call.output.slice(0, OUTPUT_PREVIEW_CHARS) }),
                ...(call.truncated !== undefined && { truncated: call.truncated }),
            };
        });
    });

/**
 * Where one device call is, by the AI SDK tool call it answers — what the
 * chat's device row shows ("waiting for approval on …"). The chat mounts it
 * only while that call is still running, never on first paint. `null` until
 * the tool created its row, and for anyone but the caller who owns it.
 */
export const getDeviceCallByToolCall = authQuery
    .input({ toolCallId: v.string().max(MAX_LENGTH.short) })
    .output(v.union(v.null(), vDeviceCallStatusView))
    .query(async ({ args, ctx }) => {
        const call = await ctx.db.deviceCalls.findFirst({ where: { toolCallId: args.toolCallId, userId: ctx.user.userId } });

        if (!call) {
            return null;
        }

        return {
            _id: call._id as string,
            deviceName: call.deviceName,
            status: call.status,
            toolName: call.toolName,
            ...(call.phase !== undefined && { phase: call.phase }),
        };
    });
