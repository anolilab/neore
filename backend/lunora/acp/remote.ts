/**
 * Starting, stopping and answering a coding agent from the web or the phone (plans/acp-agent-host.md §3, §4.4, §8 S4).
 *
 * Each of these is the OWNER's alone and only queues a signed command (`devices/lib/acp-call.ts`); the computer
 * decides whether to carry it out. Nothing here can approve a pair the user has not approved in the local window,
 * pick an "always" option, or answer from chat text: a start names a pair the signed manifest offered, an answer
 * names an option the agent itself offered, and both are checked again by Rust (`device-core/src/acp_call.rs`).
 */
import type { Infer } from "lunorash/server";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { insertThread } from "../agent/table-writes";
import { stopHostTurn } from "./lib/finish";
import { claimOnce } from "../lib/claim-once";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { createAcpCall } from "../devices/lib/acp-call";
import { ACP_CLAIM_WINDOW_MS } from "../devices/lib/constants";
import { countOpenCalls, isDeviceOnline } from "../devices/lib/state";
import { withdrawSend } from "./lib/withdraw";
import { isHostRunThread } from "./lib/host-thread";
import { sessionOfThread } from "./lib/sessions";
import { offerOf, startFailureMessage, startHostSessionIn, webSessionId } from "./lib/start";
import { vPendingPermission } from "./validators";

/** A double tap, or a retry after a lost answer, within this is the same start. */
const START_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

type Pending = Infer<typeof vPendingPermission>;

/** The owner's host thread, or null: a stranger's thread, a cloud thread and a missing one read the same. */
const ownHostThread = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">, userId: string): Promise<Doc<"threads"> | null> => {
    const thread = await ctx.db.threads.findFirst({ where: { _id: threadId, userId } });

    return thread && thread.deleted !== true && isHostRunThread(thread) ? thread : null;
};

export const liveHostStream = async (ctx: Pick<QueryCtx, "db">, threadId: Id<"threads">): Promise<Doc<"persistentStreams"> | null> =>
    await ctx.db.persistentStreams.findFirst({
        orderBy: [{ _creationTime: "desc" }],
        where: { producer: "host", status: { in: ["pending", "streaming"] }, threadId },
    });

/** Chunks looked at when finding a request the agent is waiting on: it is among the newest, since the agent is blocked. */
const REQUEST_SCAN_CHUNKS = 400;

/**
 * The permission requests a live host stream is waiting on, as the agent offered them. Only allow-once and
 * reject-once options are listed, in the agent's own order: an "always" option can neither be shown nor sent.
 */
const waitingRequests = async (ctx: Pick<QueryCtx, "db">, stream: Doc<"persistentStreams">): Promise<Pending[]> => {
    const waiting = new Set(stream.hostPendingPermissions);

    if (waiting.size === 0) {
        return [];
    }

    const { page } = await ctx.db.persistentChunks.findMany({ limit: REQUEST_SCAN_CHUNKS, orderBy: [{ seq: "desc" }], where: { streamId: stream._id } });
    const found = new Map<string, Pending>();

    for (const chunk of page) {
        const { event } = chunk;

        if (event?.kind !== "permission_request" || !waiting.has(event.requestId) || found.has(event.requestId)) {
            continue;
        }

        const incomplete = event.complete === false;

        found.set(event.requestId, {
            // A request that was cut is declined or answered on the computer, never allowed from here.
            options: event.options.filter((option) => option.kind === "reject_once" || (option.kind === "allow_once" && !incomplete)),
            requestId: event.requestId,
            tool: event.tool,
            ...(incomplete && { incomplete: true }),
            ...(event.command !== undefined && { command: event.command }),
            ...(event.folder !== undefined && { folder: event.folder }),
            ...(event.target !== undefined && { target: event.target }),
        });
    }

    // Oldest first, the order the agent asked in.
    return [...found.values()].toReversed();
};

export interface StartHostSessionInput {
    agentKey: string;
    clientId: string;
    deviceId: Id<"devices">;
    folderId: string;
}

/** The body of {@link startHostSession}, callable from another mutation that starts an agent for its own purpose. */
export const startHostSessionFor = async (ctx: MutationCtx, userId: string, args: StartHostSessionInput): Promise<{ started: boolean; threadId?: string }> => {
    const device = await ctx.db.devices.findFirst({ where: { _id: args.deviceId, userId } });
    const offer = offerOf(device, args.agentKey, args.folderId);

    if (!device?.encryptedSecret || !offer) {
        throw new LunoraError("BAD_REQUEST", "That agent is not approved for that folder on this computer. Approve it in the desktop app first.");
    }

    if (!isDeviceOnline(device, ctx.now)) {
        throw new LunoraError("BAD_REQUEST", "That computer is not online.");
    }

    // The session id comes from the client id, so a retry finds the first try's session whatever it became since.
    const hostSessionId = await webSessionId(userId, args.clientId, { kind: "start" });

    if (!(await claimOnce(ctx, "host-start", `${userId}:${args.clientId}`, START_CLAIM_TTL_MS, userId))) {
        // The first try's answer may have been lost: hand back the session it made.
        const first = await ctx.db.acpSessions.findFirst({ where: { deviceId: device._id, hostSessionId } });

        return { started: false, ...(first && { threadId: first.threadId as string }) };
    }

    const threadId = await insertThread(ctx.db, {
        createdBy: userId,
        mode: "text",
        model: offer.agentKey,
        runner: "host",
        status: "active",
        tags: ["chat", "host"],
        title: `${offer.agentLabel} · ${offer.folderLabel}`.slice(0, MAX_LENGTH.short),
        updatedAt: ctx.now,
        userId,
    });

    const call = await startHostSessionIn(ctx, { device, hostSessionId, offer, threadId, userId }, ctx.now);

    if ("error" in call) {
        // Throwing rolls the thread and the session back with the claim.
        throw new LunoraError("BAD_REQUEST", startFailureMessage(call.error));
    }

    ctx.log.event("acp.start_host_session", { started: true });

    return { started: true, threadId: threadId as string };
};

/**
 * Starts a coding agent on one of the caller's computers, for a pair the user approved there. Makes the thread and
 * its session now (`starting`) and queues `acp_start`; the session is `idle` once the computer's agent has opened it.
 * A double tap starts one session (`host-start`, claim-once).
 */
export const startHostSession = authMutation
    .use(rateLimit("hosts/start"))
    .input({
        agentKey: v.string().max(128),
        clientId: v.string().max(MAX_LENGTH.id),
        deviceId: v.id("devices"),
        folderId: v.string().max(128),
    })
    .output(v.object({ started: v.boolean(), threadId: v.optional(v.string()) }))
    .mutation(async ({ args, ctx }) => await startHostSessionFor(ctx, ctx.user.userId, args));

/**
 * Stops the turn a host thread is running: what the host wrote is kept, the stream ends, and the computer is told
 * to cancel (`stopHostTurn`). A prompt it has not yet received is withdrawn, so it cannot start once the turn is over.
 */
export const cancelHostTurn = authMutation
    .use(rateLimit("hosts/answer"))
    .input({ threadId: v.id("threads") })
    .output(v.object({ cancelled: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!(await ownHostThread(ctx, args.threadId, ctx.user.userId))) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        const stream = await liveHostStream(ctx, args.threadId);

        if (!stream) {
            return { cancelled: false };
        }

        if (stream.hostState === "accepted") {
            await withdrawSend(ctx, stream, ctx.now);
        }

        await stopHostTurn(ctx, stream, ctx.now);

        return { cancelled: true };
    });

/** The requests the agent in this thread is waiting on, for the web and the phone to show. The owner's thread only. */
export const getHostPendingPermissions = authQuery
    .input({ threadId: v.id("threads") })
    .output(v.array(vPendingPermission))
    .query(async ({ args, ctx }) => {
        if (!(await ownHostThread(ctx, args.threadId, ctx.user.userId))) {
            return [];
        }

        const stream = await liveHostStream(ctx, args.threadId);

        return stream ? await waitingRequests(ctx, stream) : [];
    });

/** The request an `acp_permission_answer` call answers, from its stored input (cleared once the call ends). */
const requestOf = (input: string): string | undefined => {
    try {
        const { requestId } = JSON.parse(input) as { requestId?: unknown };

        return typeof requestId === "string" ? requestId : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Answers a permission request from the web or the phone: allow once or decline, with an option the agent offered.
 * Queues `acp_permission_answer`; the computer's first answer, here or in its own window, wins, and the later one
 * is `already_answered` there.
 */
export const answerHostPermission = authMutation
    .use(rateLimit("hosts/answer"))
    .input({ optionId: v.string().max(128), requestId: v.string().max(128), threadId: v.id("threads") })
    .output(v.object({ reason: v.optional(v.union(v.literal("busy"), v.literal("not_waiting"), v.literal("offline"))), sent: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        if (!(await ownHostThread(ctx, args.threadId, userId))) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        const stream = await liveHostStream(ctx, args.threadId);
        const requests = stream ? await waitingRequests(ctx, stream) : [];
        const request = requests.find((candidate) => candidate.requestId === args.requestId);
        const session = await sessionOfThread(ctx, args.threadId);

        if (!request || !session || session.status === "ended") {
            return { reason: "not_waiting" as const, sent: false };
        }

        // Only an option the agent offered, and only allow-once or reject-once: `waitingRequests` lists no other.
        if (request.options.every((option) => option.optionId !== args.optionId)) {
            throw new LunoraError("BAD_REQUEST", "The agent did not offer that option.");
        }

        // One answer per request: a second tap, or the phone and the web at once, finds the first still on its way.
        // A pending call past its claim window can no longer be claimed, so it does not count.
        const queued = await countOpenCalls(
            ctx,
            session.deviceId,
            (open) =>
                open.toolName === "acp_permission_answer" &&
                open.threadId === args.threadId &&
                !(open.status === "pending" && ctx.now - open.createdAt > ACP_CLAIM_WINDOW_MS) &&
                requestOf(open.input) === args.requestId,
            1,
        );

        if (queued > 0) {
            return { sent: true };
        }

        const call = await createAcpCall(
            ctx,
            {
                deviceId: session.deviceId,
                input: { optionId: args.optionId, requestId: args.requestId, sessionId: session.hostSessionId },
                kind: "acp_permission_answer",
                threadId: args.threadId,
                userId,
            },
            ctx.now,
        );

        if ("error" in call) {
            return { reason: call.error === "offline" ? ("offline" as const) : ("busy" as const), sent: false };
        }

        ctx.log.event("acp.answer_host_permission", { sent: true });

        return { sent: true };
    });
