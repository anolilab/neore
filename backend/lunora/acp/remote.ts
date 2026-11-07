/**
 * Starting, stopping and answering a coding agent from the web or the phone (acp-agent-host.md §3, §4.4, §8 S4).
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
import { countOpenCalls, isDeviceOnline, isDeviceOutdated } from "../devices/lib/state";
import { withdrawSend } from "./lib/withdraw";
import { isHostRunThread } from "./lib/host-thread";
import { sessionOfThread } from "./lib/sessions";
import { offerOf, startFailureMessage, webSessionId } from "./lib/start";
import { openHostSession } from "./lib/start-session";
import { fitsIdBytes, vPendingPermission } from "./validators";

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

    const call = await openHostSession(ctx, { device, hostSessionId, offer, threadId, userId }, ctx.now);

    if ("error" in call) {
        // Throwing rolls the thread and the session back with the claim.
        throw new LunoraError("BAD_REQUEST", startFailureMessage(call.error));
    }

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
    .mutation(async ({ args, ctx }) => {
        const result = await startHostSessionFor(ctx, ctx.user.userId, args);

        ctx.log.event("acp.start_host_session", { started: result.started });

        return result;
    });

/**
 * Stops the turn a host thread is running: what the host wrote is kept, the stream ends, and the computer is told
 * to cancel (`stopHostTurn`). A prompt it has not yet received is withdrawn, so it cannot start once the turn is over.
 */
export const cancelHostTurn = authMutation
    .use(rateLimit("hosts/answer"))
    // `streamId` names the turn the caller saw. When it is given and another turn is live now, nothing is stopped.
    .input({ streamId: v.optional(v.id("persistentStreams")), threadId: v.id("threads") })
    // `reason` says why nothing was stopped: no turn was live, or another turn is live (`streamId` named a different one).
    // `delivered` says whether the computer was told to cancel. False means the stream ended but the stop did not reach the
    // computer, so the agent may still be running: the caller keeps its next message held instead of sending it.
    .output(
        v.object({
            cancelled: v.boolean(),
            delivered: v.optional(v.boolean()),
            reason: v.optional(v.union(v.literal("no_turn"), v.literal("other_turn"))),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        if (!(await ownHostThread(ctx, args.threadId, ctx.user.userId))) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        // The turn the caller named is the one to stop when it is still a live host turn of this thread, even if a newer host
        // turn is live too. Otherwise the newest host turn is the candidate, and the check below refuses it when the caller named
        // another turn.
        const named = args.streamId === undefined ? null : await ctx.db.get("persistentStreams", args.streamId);
        const namedLive =
            named !== null && named.threadId === args.threadId && named.producer === "host" && (named.status === "pending" || named.status === "streaming");
        const stream = namedLive ? named : await liveHostStream(ctx, args.threadId);

        if (!stream) {
            ctx.log.event("acp.cancel_host_turn", { cancelled: false, reason: "no_turn", withdrewPrompt: false });

            return { cancelled: false, reason: "no_turn" as const };
        }

        if (args.streamId !== undefined && stream._id !== args.streamId) {
            ctx.log.event("acp.cancel_host_turn", { cancelled: false, reason: "other_turn", withdrewPrompt: false });

            return { cancelled: false, reason: "other_turn" as const };
        }

        if (stream.hostState === "accepted") {
            await withdrawSend(ctx, stream, ctx.now);
        }

        const withdrewPrompt = stream.hostState === "accepted";

        const delivered = await stopHostTurn(ctx, stream, ctx.now);

        ctx.log.event("acp.cancel_host_turn", { cancelled: true, delivered, withdrewPrompt });

        return { cancelled: true, delivered };
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

/**
 * Whether the agent's reported state lists this value: for an option, one of its choices; with no option, a mode of the legacy
 * mode state, which only stands in when the agent sent no options at all.
 */
const isOfferedValue = (state: Doc<"acpSessions">["agentState"], optionId: string | undefined, valueId: string): boolean => {
    if (optionId !== undefined) {
        return state?.configOptions?.find((option) => option.id === optionId)?.choices.some((choice) => choice.value === valueId) === true;
    }

    return (state?.configOptions?.length ?? 0) === 0 && state?.modes?.available.some((mode) => mode.id === valueId) === true;
};

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
    .output(
        v.object({ reason: v.optional(v.union(v.literal("busy"), v.literal("not_waiting"), v.literal("offline"), v.literal("outdated"))), sent: v.boolean() }),
    )
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
        let queuedPending = false;
        const queued = await countOpenCalls(
            ctx,
            session.deviceId,
            (open) => {
                const mine =
                    open.toolName === "acp_permission_answer" &&
                    open.threadId === args.threadId &&
                    !(open.status === "pending" && ctx.now - open.createdAt > ACP_CLAIM_WINDOW_MS) &&
                    requestOf(open.input) === args.requestId;

                queuedPending ||= mine && open.status === "pending";

                return mine;
            },
            1,
        );

        if (queued > 0) {
            // A still-pending answer would be failed at claim on a computer that has since gone outdated: not sent.
            const device = queuedPending ? await ctx.db.devices.findFirst({ where: { _id: session.deviceId, userId } }) : null;

            if (device && isDeviceOutdated(device)) {
                return { reason: "outdated" as const, sent: false };
            }

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
            return { reason: call.error === "offline" || call.error === "outdated" ? call.error : ("busy" as const), sent: false };
        }

        ctx.log.event("acp.answer_host_permission", { sent: true });

        return { sent: true };
    });

/**
 * Changes one of the agent's options (its model, reasoning effort, mode ...) from the web or the phone. The owner's
 * alone, and only for a value the agent itself listed in the state it reported (`acpSessions.agentState`): the option
 * and the value are read back from that state, so neither can be invented here. Queues `acp_set_config`; the computer
 * asks the agent and the session row records the answer (`optionResult`, `acp/lib/calls.ts`). A mode is never changed from here:
 * a call with no `optionId` (the legacy mode state) or naming a mode option is refused.
 */
export const setHostOption = authMutation
    .use(rateLimit("hosts/answer"))
    .input({
        optionId: v.optional(v.string().check(fitsIdBytes, { message: "An id is at most 128 bytes" })),
        threadId: v.id("threads"),
        valueId: v.string().min(1).check(fitsIdBytes, { message: "An id is at most 128 bytes" }),
    })
    .output(
        v.object({
            callId: v.optional(v.string()),
            reason: v.optional(v.union(v.literal("busy"), v.literal("ended"), v.literal("offline"), v.literal("outdated"), v.literal("unpaired"))),
            sent: v.boolean(),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        if (!(await ownHostThread(ctx, args.threadId, userId))) {
            throw new LunoraError("NOT_FOUND", "Thread not found");
        }

        const session = await sessionOfThread(ctx, args.threadId);

        if (!session || session.status === "ended") {
            return { reason: "ended" as const, sent: false };
        }

        if (!isOfferedValue(session.agentState, args.optionId, args.valueId)) {
            throw new LunoraError("BAD_REQUEST", "The agent did not offer that option.");
        }

        // A mode can grant standing permissions (edits, every tool, without asking), and a remote answer may only allow once or
        // decline: so a mode is changed on the computer, where the person sees what it grants. Only other options change from here.
        const option = args.optionId === undefined ? undefined : session.agentState?.configOptions?.find((entry) => entry.id === args.optionId);

        if (args.optionId === undefined || option?.category?.toLowerCase() === "mode") {
            throw new LunoraError("BAD_REQUEST", "A mode is changed on the computer, not from here.");
        }

        // One change at a time: a double tap, or the phone and the web at once, finds the first still on its way.
        const queued = await countOpenCalls(
            ctx,
            session.deviceId,
            (open) =>
                open.toolName === "acp_set_config" &&
                open.threadId === args.threadId &&
                !(open.status === "pending" && open.claimedAt === undefined && ctx.now - open.createdAt > ACP_CLAIM_WINDOW_MS),
            1,
        );

        if (queued > 0) {
            return { reason: "busy" as const, sent: false };
        }

        const call = await createAcpCall(
            ctx,
            {
                deviceId: session.deviceId,
                input: { sessionId: session.hostSessionId, valueId: args.valueId, ...(args.optionId !== undefined && { optionId: args.optionId }) },
                kind: "acp_set_config",
                threadId: args.threadId,
                userId,
            },
            ctx.now,
        );

        if ("error" in call) {
            const { error } = call;

            if (error === "offline" || error === "outdated") {
                return { reason: error, sent: false };
            }

            return { reason: error === "ineligible" ? ("unpaired" as const) : ("busy" as const), sent: false };
        }

        ctx.log.event("acp.set_host_option", { sent: true });

        return { callId: call.callId, sent: true };
    });
