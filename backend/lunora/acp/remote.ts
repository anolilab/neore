/**
 * Starting, stopping and answering a coding agent from the web or the phone (acp-agent-host.md §3, §4.4, §8 S4).
 *
 * Each of these is the OWNER's alone and only queues a signed command (`devices/lib/acp-call.ts`); the computer
 * decides whether to carry it out. Nothing here can approve a pair the user has not approved in the local window,
 * pick an "always" option, or answer from chat text: a start names a pair the signed manifest offered, an answer
 * names an option the agent itself offered, and both are checked again by Rust (`device-core/src/acp_call.rs`).
 */
import type { Infer } from "lunorash/server";
import { capabilityOf, isAvailable } from "@neore/ai/capabilities";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { insertThread, insertThreadRelationship } from "../agent/table-writes";
import { stopHostTurn } from "./lib/finish";
import { claimFence, claimRow, recordClaimResult, releaseClaim } from "../lib/claim-once";
import { getMaxMessage } from "../agent/messages";
import { discardNewThread } from "../chat/side-chat";
import { authAction, authMutation, authQuery, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { createAcpCall } from "../devices/lib/acp-call";
import { isDeviceInScope } from "../devices/lib/scope";
import { ACP_CLAIM_WINDOW_MS, MAX_DEVICES_PER_USER } from "../devices/lib/constants";
import { countOpenCalls, isDeviceOnline, isDeviceOutdated } from "../devices/lib/state";
import { withdrawSend } from "./lib/withdraw";
import { isThreadLocked } from "../lib/thread-lock";
import { isHostRunThread } from "./lib/host-thread";
import { hostOrganizationRefusal } from "./lib/organization-cap";
import { nativeIdFits } from "./lib/reattach";
import { sessionOfThread } from "./lib/sessions";
import { projectRunnerOf, runnerStillOffered } from "./lib/project-runner";
import { HOST_START_OUT_OF_SCOPE, offerOf, startFailureMessage, webSessionId } from "./lib/start";
import { openHostSession } from "./lib/start-session";
import type { DeviceTaintSource } from "../devices/lib/taint";
import { vDeviceTaintSource } from "../devices/validators";
import { readableProject, writableProject } from "../projects/functions";
import { fitsIdBytes, vPendingPermission } from "./validators";

/** A double tap, or a retry after a lost answer, within this is the same start. */
const START_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
/** A fork's claim: the copy takes seconds, so a fork the action never finished (it was cut off between its two halves) frees its key soon, not after a day. */
const FORK_CLAIM_TTL_MS = 10 * 60 * 1000;

type Pending = Infer<typeof vPendingPermission>;

/** The host session a queued call's input names, or undefined when the input names none. */
const inputSessionOf = (input: string): string | undefined => {
    try {
        const parsed: unknown = JSON.parse(input);

        return typeof parsed === "object" && parsed !== null && "sessionId" in parsed && typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
    } catch {
        return undefined;
    }
};

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
    /** Make the thread and take the claim, but queue no session: the caller does that once it has copied the history in (`forkHostThreadRun`). */
    deferOpen?: boolean;
    deviceId: Id<"devices">;
    folderId: string;
    /** The chat this start forks (with `forkSessionId`): its claim and session id are its own, not an ordinary start's. */
    forkOfThreadId?: string;
    /** The agent's own session id to fork into the new thread's session (`forkHostThread`); no client names it. */
    forkSessionId?: string;
    /** The caller's verified active organization (`ctx.user.activeOrganization`), unset in the personal space. */
    organizationId?: string;
    /** The project the thread is filed under; the start then remembers its runner there (`lib/project-runner.ts`). */
    projectId?: Id<"projects">;
    /** What the session the new one forks was handed over (`acpSessions.taintedBy`): carried, so a fork never has less warning than its source. */
    taintedBy?: ReadonlyArray<DeviceTaintSource>;
}

/**
 * What a start whose claim was already taken answers: the session the first try made, so a lost answer is found again.
 * `requested` is the project the first try was for, as the claim read once by the caller recorded it (a claim from before that
 * was recorded has none: those starts took no project). A retry naming another project is not the same start, so it is refused
 * rather than handed the first try's thread, whichever computer it names: the session is looked up on that computer only.
 */
const answerRetry = async (
    ctx: MutationCtx,
    deviceId: Id<"devices">,
    hostSessionId: string,
    requested: string,
    projectId: string,
): Promise<{ started: boolean; threadId?: string }> => {
    if (requested !== projectId) {
        throw new LunoraError("BAD_REQUEST", "That start was made for another project. Start it again from the project it was made in.");
    }

    const first = await ctx.db.acpSessions.findFirst({ where: { deviceId, hostSessionId } });

    return { started: false, ...(first && { threadId: first.threadId as string }) };
};

/** The body of {@link startHostSession}, callable from another mutation that starts an agent for its own purpose. */
export const startHostSessionFor = async (ctx: MutationCtx, userId: string, args: StartHostSessionInput): Promise<{ started: boolean; threadId?: string }> => {
    // From the primary: the device's pairing and project scope decide the start, and a replica can still show them as they were.
    const device = await ctx.db.devices.findFirst({ consistency: "primary", where: { _id: args.deviceId, userId } });
    const offer = offerOf(device, args.agentKey, args.folderId);

    if (!device?.encryptedSecret || !offer) {
        throw new LunoraError("BAD_REQUEST", "That agent is not approved for that folder on this computer. Approve it in the desktop app first.");
    }

    // The session id comes from the client id, so a retry finds the first try's session whatever it became since.
    // A fork has a claim and a session id of its own, keyed by the chat it forks, so one operation never replays the other.
    const claimScope = args.forkOfThreadId === undefined ? "host-start" : "host-fork";
    const hostSessionId = await webSessionId(
        userId,
        args.clientId,
        args.forkOfThreadId === undefined ? { kind: "start" } : { kind: "fork", threadId: args.forkOfThreadId },
    );
    const startKey = args.forkOfThreadId === undefined ? `${userId}:${args.clientId}` : `${userId}:${args.forkOfThreadId}:${args.clientId}`;
    // Checked before the claim: a project the caller may not file into refuses the start and gives nothing up. From the primary:
    // the project's organization decides whose cap holds the start, and a replica can still show the one it just moved out of.
    const project = args.projectId ? await writableProject(ctx, args.projectId, userId, { primary: true }) : null;
    // The first try's claim, read once: a retry is judged by what this one read recorded, so a claim lapsing between two reads
    // cannot make the same start look like another.
    const firstTry = await claimRow(ctx, claimScope, startKey);
    // A computer limited to some projects starts threads only in those, the rule a switch and its tools follow (`devices/lib/scope.ts`):
    // a thread with no project is in none of them.
    let refusal: LunoraError | null = null;

    if (args.projectId && !project) {
        refusal = new LunoraError("FORBIDDEN", "Project not found or access denied");
    } else if (!isDeviceInScope(device, project?._id)) {
        refusal = new LunoraError(
            "BAD_REQUEST",
            project
                ? "That computer is not allowed in this project. Change which projects it may be used in, in its settings."
                : "That computer may only be used in some projects. Start the agent from one of them, or change this in its settings.",
            { data: { code: HOST_START_OUT_OF_SCOPE } },
        );
    }

    if (refusal) {
        // A retry of a start that went through, its project deleted or closed to the computer since: the first try's thread is still the answer.
        if (firstTry) {
            return await answerRetry(ctx, device._id, hostSessionId, firstTry.result ?? "", args.projectId ?? "");
        }

        throw refusal;
    }

    if (!isDeviceOnline(device, ctx.now)) {
        throw new LunoraError("BAD_REQUEST", "That computer is not online.");
    }

    if (firstTry) {
        return await answerRetry(ctx, device._id, hostSessionId, firstTry.result ?? "", project?._id ?? "");
    }

    // No live claim was read above, and none can be taken in between: this transaction is the only writer of it.
    const claimedAt = await claimFence(ctx, claimScope, startKey, { ttlMs: args.deferOpen === true ? FORK_CLAIM_TTL_MS : START_CLAIM_TTL_MS, userId });

    if (claimedAt === null) {
        throw new LunoraError("CONFLICT", "That start is already being made.");
    }

    // The project this start is for is kept on its claim, so a retry is judged by it and not by where the thread is filed now.
    await recordClaimResult(ctx, claimScope, startKey, claimedAt, project?._id ?? "");

    // A project of an organization files its thread under that organization, whatever space the start came from, so the
    // organization's cap holds the thread. Otherwise the thread is filed under the caller's organization: a project moved
    // out of one keeps `organizationId: ""`, which is no organization.
    const organizationId = project?.organizationId || args.organizationId;

    // After the claim, so a retry of a start that went through still finds its session. Throwing gives the claim back.
    const refused = await hostOrganizationRefusal(ctx, organizationId, userId);

    if (refused) {
        throw new LunoraError("FORBIDDEN", refused);
    }

    // Filed under the organization it was started in, as a chat is: its cap holds the thread whatever space it is used from.
    const threadId = await insertThread(ctx.db, {
        createdBy: userId,
        mode: "text",
        model: offer.agentKey,
        ...(project && { projectId: project._id }),
        ...(organizationId && { organizationId }),
        runner: "host",
        status: "active",
        tags: ["chat", "host"],
        title: `${offer.agentLabel} · ${offer.folderLabel}`.slice(0, MAX_LENGTH.short),
        updatedAt: ctx.now,
        userId,
    });

    // A fork opens its session later: the history is copied into the new chat first, so an early turn finds the copied prompts in place.
    if (args.deferOpen === true) {
        return { started: true, threadId: threadId as string };
    }

    const call = await openHostSession(
        ctx,
        {
            device,
            ...(args.forkSessionId !== undefined && { forkSessionId: args.forkSessionId }),
            hostSessionId,
            offer,
            ...(args.taintedBy !== undefined && { taintedBy: args.taintedBy }),
            threadId,
            userId,
        },
        ctx.now,
    );

    if ("error" in call) {
        // Throwing rolls the thread and the session back with the claim.
        throw new LunoraError("BAD_REQUEST", startFailureMessage(call.error));
    }

    // The project's default is recorded when the agent opens (`acp/ingest.ts`), not here: a start the computer refuses leaves it.
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
        projectId: v.optional(v.id("projects")),
    })
    .output(v.object({ started: v.boolean(), threadId: v.optional(v.string()) }))
    .mutation(async ({ args, ctx }) => {
        const result = await startHostSessionFor(ctx, ctx.user.userId, { ...args, organizationId: ctx.user.activeOrganization?.id });

        ctx.log.event("acp.start_host_session", { started: result.started });

        return result;
    });

/**
 * Forks a coding agent's chat: a new chat on the same computer, folder and agent whose session continues the agent's own session of
 * this one (`forkSessionId`, read here from the caller's own session row, never from the client). The source chat is left as it is
 * and the two share the folder. Owner only, and only an agent that said it forks sessions: one that did not would open an empty
 * session that only looks like a fork. A double tap forks once (`clientId`, as a start's).
 */
/** What a begun fork answers: the new chat, the marks its copied history carries, and what opening its session needs (absent for a retry). */
const vBegunFork = v.object({
    hasContextReset: v.optional(v.boolean()),
    hasHandoff: v.optional(v.boolean()),
    open: v.optional(
        v.object({
            agentKey: v.string(),
            deviceId: v.id("devices"),
            folderId: v.string(),
            forkSessionId: v.string(),
            /** The source chat's session the fork was made from: the one it must still be when the fork's session is queued. */
            sourceSessionId: v.id("acpSessions"),
            taintedBy: v.optional(v.array(vDeviceTaintSource)),
        }),
    ),
    /** Whether the source chat has any message at all: with no settled one to copy up to, that tells a long or still-replying chat from an empty one. */
    sourceHasMessages: v.optional(v.boolean()),
    started: v.boolean(),
    threadId: v.optional(v.string()),
});

export const beginHostFork = internalMutation
    .input({ clientId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads"), userId: v.string() })
    .output(vBegunFork)
    .mutation(async ({ args, ctx }) => {
        const { userId } = args;
        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: args.threadId, userId } });

        // A chat that is not the caller's answers as one that does not exist.
        if (!thread || thread.deleted === true || !isHostRunThread(thread)) {
            throw new LunoraError("NOT_FOUND", "Chat not found");
        }

        if (isThreadLocked(thread)) {
            throw new LunoraError("FORBIDDEN", "Unlock this chat to fork it.");
        }

        // A retry of a fork that went through is answered from its own record, before the source's newest session is looked at: the
        // source may have switched agent or computer since, and the fork it already made is still the answer.
        const hostSessionId = await webSessionId(userId, args.clientId, { kind: "fork", threadId: String(thread._id) });
        const { page: devices } = await ctx.db.devices.findMany({ limit: MAX_DEVICES_PER_USER, where: { userId } });

        for (const device of devices) {
            const first = await ctx.db.acpSessions.findFirst({ where: { deviceId: device._id, hostSessionId } });

            if (first) {
                return { started: false, threadId: first.threadId as string };
            }
        }

        const session = await sessionOfThread(ctx, thread._id);
        const nativeId = session?.nativeSessionId;

        if (!session || session.userId !== userId || nativeId === undefined || !nativeIdFits(nativeId)) {
            throw new LunoraError("BAD_REQUEST", "This chat has no saved agent session to fork yet. Send a message first.");
        }

        if (!isAvailable(capabilityOf(session.capabilities, "sessions.fork"))) {
            throw new LunoraError("BAD_REQUEST", "This agent cannot fork a session.");
        }

        // The new chat is the source chat's own, not the caller's active space: filed under the organization it is in (or the one that caps
        // it), so that organization's membership and host-agent cap are checked as for any start there (`startHostSessionFor`), and a chat
        // of a space the caller has left, or whose cap no longer allows an agent on a computer, is refused rather than forked into another.
        const organizationId = thread.organizationId || thread.capOrganizationId;
        const result = await startHostSessionFor(ctx, userId, {
            agentKey: session.agentKey,
            clientId: args.clientId,
            // Keyed by the source chat too (and a claim of their own): the id is the caller's per click, and one reused for another chat, or
            // for an ordinary start, is another operation, not a replay.
            deferOpen: true,
            deviceId: session.deviceId,
            folderId: session.folderId,
            forkOfThreadId: String(thread._id),
            forkSessionId: nativeId,
            ...(organizationId && { organizationId }),
            ...(thread.projectId && { projectId: thread.projectId }),
            // Whatever the source session was handed over stays warned about: the fork carries the whole of its context.
            ...(session.taintedBy !== undefined && session.taintedBy.length > 0 && { taintedBy: session.taintedBy }),
        });

        // Once, by the start that made the thread: a retry of it finds the link already there.
        if (result.started && result.threadId !== undefined) {
            await insertThreadRelationship(ctx.db, {
                branchType: "branch",
                createdAt: ctx.now,
                parentThreadId: thread._id,
                threadId: result.threadId as Id<"threads">,
                userId,
            });
        }

        ctx.log.event("acp.fork_host_thread", { started: result.started });

        const newest = await getMaxMessage(ctx, thread._id);

        // What the copied history carries with it (`/clear`, a handed-over conversation), marked on the new chat after the copy as a side chat does.
        return {
            ...result,
            ...(thread.hasContextReset === true && { hasContextReset: true }),
            ...(thread.hasHandoff === true && { hasHandoff: true }),
            ...(newest !== null && newest !== undefined && { sourceHasMessages: true }),
            ...(result.started && {
                open: {
                    agentKey: session.agentKey,
                    deviceId: session.deviceId,
                    folderId: session.folderId,
                    forkSessionId: nativeId,
                    sourceSessionId: session._id,
                    ...(session.taintedBy !== undefined && session.taintedBy.length > 0 && { taintedBy: session.taintedBy }),
                },
            }),
        };
    });

/**
 * The second half of a fork: queues the new chat's session, once its history is in place. The computer and the (agent, folder) pair are
 * checked again, as for any start, and a session that cannot be queued throws so the caller takes the new chat back.
 */
export const openHostFork = internalMutation
    .input({
        agentKey: v.string(),
        clientId: v.string().max(MAX_LENGTH.id),
        deviceId: v.id("devices"),
        folderId: v.string(),
        forkOfThreadId: v.id("threads"),
        forkSessionId: v.string(),
        sourceSessionId: v.id("acpSessions"),
        taintedBy: v.optional(v.array(vDeviceTaintSource)),
        threadId: v.id("threads"),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const { userId } = args;
        const thread = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: args.threadId, userId } });
        const device = await ctx.db.devices.findFirst({ consistency: "primary", where: { _id: args.deviceId, userId } });
        const offer = offerOf(device, args.agentKey, args.folderId);

        // A chat being deleted had its session ended by the deletion: it is not given a new one.
        if (!thread || thread.deleted === true || thread.deletingAt !== undefined || !isHostRunThread(thread) || !device?.encryptedSecret || !offer) {
            throw new LunoraError("BAD_REQUEST", "That agent is not approved for that folder on this computer. Approve it in the desktop app first.");
        }

        // The history was copied since the fork began, and the source, the caller's membership and the project may have changed meanwhile:
        // everything a start refuses on is read again here, before anything is queued (the caller takes the new chat back on a refusal).
        // A source that was locked or trashed after the copy is no source any more, whether or not there was anything to copy.
        const source = await ctx.db.threads.findFirst({ consistency: "primary", where: { _id: args.forkOfThreadId, userId } });

        if (!source || source.deleted === true || source.deletingAt !== undefined) {
            throw new LunoraError("NOT_FOUND", "Chat not found");
        }

        if (isThreadLocked(source)) {
            throw new LunoraError("FORBIDDEN", "Unlock this chat to fork it.");
        }

        // The agent session this fork continues must still be the source chat's own: a switch of agent (or a new session) while the history was
        // copied would leave the new chat holding messages the session it continues has never seen.
        const current = await sessionOfThread(ctx, source._id);

        if (current?._id !== args.sourceSessionId || current.nativeSessionId !== args.forkSessionId) {
            throw new LunoraError("CONFLICT", "This chat's agent changed while it was being forked. Fork it again.");
        }

        const refused = await hostOrganizationRefusal(ctx, thread.organizationId || thread.capOrganizationId, userId);

        if (refused) {
            throw new LunoraError("FORBIDDEN", refused);
        }

        const project = thread.projectId ? await writableProject(ctx, thread.projectId, userId, { primary: true }) : null;

        if (thread.projectId && !project) {
            throw new LunoraError("FORBIDDEN", "Project not found or access denied");
        }

        if (!isDeviceInScope(device, project?._id)) {
            throw new LunoraError("BAD_REQUEST", "That computer is not allowed in this project. Change which projects it may be used in, in its settings.", {
                data: { code: HOST_START_OUT_OF_SCOPE },
            });
        }

        const call = await openHostSession(
            ctx,
            {
                device,
                forkSessionId: args.forkSessionId,
                hostSessionId: await webSessionId(userId, args.clientId, { kind: "fork", threadId: String(args.forkOfThreadId) }),
                offer,
                ...(args.taintedBy !== undefined && { taintedBy: args.taintedBy }),
                threadId: thread._id,
                userId,
            },
            ctx.now,
        );

        if ("error" in call) {
            throw new LunoraError("BAD_REQUEST", startFailureMessage(call.error));
        }

        return null;
    });

/** Gives back the claim of a fork whose new chat was taken back, so the same click can fork again (a claim otherwise holds its key for a day). */
export const releaseHostForkClaim = internalMutation
    .input({ clientId: v.string().max(MAX_LENGTH.id), forkOfThreadId: v.id("threads"), userId: v.string() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await releaseClaim(ctx, "host-fork", `${args.userId}:${args.forkOfThreadId}:${args.clientId}`);

        return null;
    });

/**
 * The fork's whole run, given the functions it calls (so a test can drive it without a deployment): the start in one transaction
 * (`beginHostFork`), then the source chat's settled history copied into the new chat as a side chat's is (`cloneThread`, up to the source's
 * last SETTLED message, so a reply still in flight is not copied, and refused for a trashed source). A copy that fails takes the new chat back,
 * as a side chat does, so no empty chat is left for a person who never asked for one.
 */
export const forkHostThreadRun = async (
    ctx: Pick<ActionCtx, "runAction" | "runMutation" | "runQuery">,
    args: { clientId: string; threadId: Id<"threads">; userId: string },
): Promise<{ started: boolean; threadId?: string }> => {
    const begun = await ctx.runMutation(internal.acp.remote.beginHostFork, args);

    // A retry of a fork that went through: its history was copied and its session queued by the first try.
    if (!begun.started || begun.threadId === undefined || begun.open === undefined) {
        return { started: begun.started, ...(begun.threadId !== undefined && { threadId: begun.threadId }) };
    }

    const newThreadId = begun.threadId as Id<"threads">;

    try {
        const settledId = await ctx.runQuery(internal.agent.branches.lastSettledMessageId, { threadId: args.threadId });
        const forkEnd =
            settledId === null
                ? null
                : await ctx.runQuery(internal.agent.branches.resolveForkEnd, { index: undefined, messageId: settledId, threadId: args.threadId });

        // No settled message to copy up to is an empty chat to fork only when it has no message at all: a chat with messages and no settled one
        // is still replying, or is longer than the scan for its last settled message reaches. Forking it would open a chat with none of its
        // history, so it is refused (nothing is queued, and the new chat is taken back).
        if (forkEnd === null && begun.sourceHasMessages === true) {
            throw new LunoraError("BAD_REQUEST", "This chat cannot be forked yet: wait for its reply to finish, or it is too long to fork.");
        }

        if (forkEnd !== null) {
            await ctx.runAction(internal.agent.messages.cloneThread, {
                copyUserIdForVectorSearch: true,
                refuseTrashedSource: true,
                sourceThreadId: args.threadId,
                statuses: ["success"],
                targetThreadId: newThreadId,
                upToAndIncludingMessageId: forkEnd.endId,
            });
        }

        // The copy carries a context reset (`/clear`) and a handed-over conversation: the new chat is cut at the one and stays marked as the other.
        if (begun.hasContextReset === true) {
            await ctx.runMutation(internal.chat.context_reset.markForkedContextReset, { threadId: newThreadId });
        }

        if (begun.hasHandoff === true) {
            await ctx.runMutation(internal.chat.context_reset.markForkedHandoff, { threadId: newThreadId });
        }

        // Last: the agent's session is queued only once the chat holds its history, so a turn that starts at once cannot meet the copy
        // half done (and a copy that failed above queued nothing).
        await ctx.runMutation(internal.acp.remote.openHostFork, {
            ...begun.open,
            clientId: args.clientId,
            forkOfThreadId: args.threadId,
            threadId: newThreadId,
            userId: args.userId,
        });
    } catch (error) {
        await discardNewThread(ctx, newThreadId);
        // Best effort: a claim left behind only holds the key until it lapses.
        await ctx
            .runMutation(internal.acp.remote.releaseHostForkClaim, { clientId: args.clientId, forkOfThreadId: args.threadId, userId: args.userId })
            .catch(() => undefined);

        throw error;
    }

    return { started: true, threadId: begun.threadId };
};

export const forkHostThread = authAction
    .use(rateLimit("hosts/start"))
    .input({ clientId: v.string().max(MAX_LENGTH.id), threadId: v.id("threads") })
    .output(v.object({ started: v.boolean(), threadId: v.optional(v.string()) }))
    .action(async ({ args, ctx }) => await forkHostThreadRun(ctx, { ...args, userId: ctx.user.userId }));

/**
 * The computer and agent a new thread in `projectId` starts on by default for the caller: the runner its last host
 * thread used, or null when there is none, or the computer no longer is the caller's or no longer offers that pair.
 */
export const getProjectRunnerDefault = authQuery
    .input({ projectId: v.id("projects") })
    .output(v.union(v.object({ agentKey: v.string(), deviceId: v.string(), folderId: v.string() }), v.null()))
    .query(async ({ args, ctx }) => {
        const { userId } = ctx.user;
        // From the primary: a membership revoked a moment ago must not hand back the saved runner from a lagging replica.
        const project = await readableProject(ctx, args.projectId, userId, { primary: true });

        if (!project) {
            ctx.log.event("acp.get_project_runner_default", { found: false });

            return null;
        }

        const settings = project.organizationId ? await ctx.db.userSettings.findFirst({ where: { userId } }) : null;
        const runner = projectRunnerOf(project, settings);
        const deviceId = runner ? ctx.db.normalizeId("devices", runner.deviceId) : null;
        // From the primary too, as the start reads it: an unpaired computer or a narrowed project scope must not be preselected.
        const device = deviceId ? await ctx.db.devices.findFirst({ consistency: "primary", where: { _id: deviceId, userId } }) : null;

        const offered = runner !== null && runnerStillOffered(device, runner, project._id);

        ctx.log.event("acp.get_project_runner_default", { found: offered });

        return offered ? runner : null;
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
 * a call with no `optionId` (the legacy mode state) or naming a mode option is refused. `sessionId` is the session row the
 * person was choosing against: a change queued while that session was replaced by a newer one is not applied to the new one.
 */
export const setHostOption = authMutation
    .use(rateLimit("hosts/answer"))
    .input({
        optionId: v.optional(v.string().check(fitsIdBytes, { message: "An id is at most 128 bytes" })),
        sessionId: v.string().min(1).check(fitsIdBytes, { message: "An id is at most 128 bytes" }),
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

        if (!session || session.status === "ended" || String(session._id) !== args.sessionId) {
            return { reason: "ended" as const, sent: false };
        }

        if (!isOfferedValue(session.agentState, args.optionId, args.valueId)) {
            throw new LunoraError("BAD_REQUEST", "The agent did not offer that option.");
        }

        // A mode can grant standing permissions (edits, every tool, without asking), and a remote answer may only allow once or
        // decline: so a mode is changed on the computer, where the person sees what it grants. This is the set the desktop
        // refuses too (`setRemoteOption` in apps/desktop/src/acp/session.ts): a mode, an option filed under no category (it
        // cannot be shown not to be a mode), and an id the legacy mode state lists. Only other options change from here.
        const option = args.optionId === undefined ? undefined : session.agentState?.configOptions?.find((entry) => entry.id === args.optionId);
        const legacyMode = args.optionId !== undefined && session.agentState?.modes?.available.some((mode) => mode.id === args.optionId) === true;
        const isMode = option !== undefined && (option.category === undefined || option.category.toLowerCase() === "mode");

        if (args.optionId === undefined || legacyMode || isMode) {
            throw new LunoraError("BAD_REQUEST", "A mode is changed on the computer, not from here.");
        }

        // One change at a time: a double tap, or the phone and the web at once, finds the first still on its way.
        // Only a change to this session counts: an unanswered change to the agent the thread used before does not hold back this one.
        const queued = await countOpenCalls(
            ctx,
            session.deviceId,
            (open) =>
                open.toolName === "acp_set_config" &&
                open.threadId === args.threadId &&
                inputSessionOf(open.input) === session.hostSessionId &&
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
