/**
 * A switch to or from a coding agent on a paired computer (plans/harness-switch.md §3, slice S3).
 *
 * `chat/agent-switch.ts` routes here whenever the target is a host agent or the thread is a host-run one; the cloud
 * model switch and its summary call stay there. What differs, and why this is one mutation:
 *
 * - **The runner never changes inside a thread** (plans/acp-agent-host.md §5.1). Host to host stays in the thread: the
 *   session it ran in ends and a new one opens in the same thread. Cloud to host and host to cloud make a NEW thread,
 *   linked to the source by a `continuation` relationship, and leave the source thread exactly as it was.
 * - **The handoff is the newest turns, verbatim.** A coding agent is sent a text and nothing else, and the signed call
 *   carries 32 KiB, so there is no summary call and no charge: only the turns that fit (`composeTailHandoff`), and a
 *   line saying how many are left out. It is stored on the divider like a cloud handoff. A host agent is sent it once,
 *   in front of its first prompt (`acp/lib/pending-handoff.ts`, used by `/hosts/send`); a cloud thread reads it from the
 *   divider, which is its first row, like any other handoff.
 * - **Consent is not created.** The target must be a pair the computer already offers (`devices.acpOffers`, written
 *   only from the signed manifest of a local approval). Rust checks the pair again on the `acp_start` it receives.
 * - **Owner only.** A coding-agent thread cannot be shared, and a fork starts something on the owner's computer, so a
 *   collaborator's write grant (enough to pick a cloud model for a send) is not enough here.
 *
 * Everything is checked before the first write, and a refused `acp_start` throws, which takes the thread, the session
 * and the divider with it.
 */
import { CHARACTERS_PER_TOKEN } from "@neore/ai/models";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { leafRowOf, resolvePathAgent } from "../agent/agent-switch";
import { agentKeyOf, sameAgent } from "../agent/agent-switch-logic";
import { type HostAgentRef, type SwitchAgentRef, vSwitchAgentRef } from "../agent/agent-switch-validators";
import { composeTailHandoff, HANDOFF_BUDGET_TOKENS, HandoffTooLargeError, HANDOFF_REFUSED_TOO_LARGE, jsonBytes } from "../agent/handoff";
import { collectHandoffSource, findDividerLeaving } from "../agent/handoff-source";
import { getMaxMessage } from "../agent/messages";
import { insertAgentSwitchRow, insertThread, insertThreadRelationship, patchAgentSwitchRow, patchThread } from "../agent/table-writes";
import { requireThreadPermission } from "../agent/thread-read-access";
import { HOST_HANDOFF_TAINT, threadPathTaint } from "../agent/thread-summary-taint";
import { getUser } from "../auth/lib/better-auth-queries";
import {
    AGENT_SWITCH_CLAIM_TTL_MS,
    AGENT_SWITCH_HOST_OFFLINE,
    AGENT_SWITCH_NOT_OFFERED,
    AGENT_SWITCH_STREAMING,
    AGENT_SWITCH_UNSUPPORTED,
    assertNotStreaming,
    claimKeyOf,
    hasFixedAgent,
    refuse,
    type SwitchArgs,
    type SwitchResult,
    vSwitchTarget,
} from "../chat/agent-switch";
import { assertPaidModel, requireEnabledModel } from "../chat/lib/enabled-model";
import { isDeviceOnline } from "../devices/lib/state";
import { type DeviceTaintSource, mergeTaint } from "../devices/lib/taint";
import { claimedAtOf, claimOnce } from "../lib/claim-once";
import { checkRateLimit } from "../lib/rate-limiter";
import { MAX_LENGTH } from "../lib/validators";
import { isHostRunThread } from "./lib/host-thread";
import { HOST_HANDOFF_MAX_BYTES, pendingHandoffOf } from "./lib/pending-handoff";
import { savedSessionFor } from "./lib/reattach";
import { sessionOfThread } from "./lib/sessions";
import { offerOf, startFailureMessage, startHostSessionIn, webSessionId } from "./lib/start";
import { liveHostStream } from "./remote";

type Device = Doc<"devices">;
type Offer = NonNullable<Device["acpOffers"]>[number];
type Session = Doc<"acpSessions">;

type ResolvedTarget = { device: Device; kind: "host"; offer: Offer } | { kind: "model"; model: string };

const hostRefOf = (hostId: string, offer: Pick<Offer, "agentKey" | "agentLabel" | "folderId" | "folderLabel">): HostAgentRef => {
    return {
        agentKey: offer.agentKey,
        agentLabel: offer.agentLabel,
        folderId: offer.folderId,
        folderLabel: offer.folderLabel,
        hostId,
        kind: "host",
    };
};

const sessionRefOf = (session: Session): HostAgentRef => hostRefOf(session.deviceId as string, session);

/** The title a thread that takes over on a computer gets: the agent and the folder, never a path. */
const hostTitle = (offer: Offer): string => `${offer.agentLabel} · ${offer.folderLabel}`.slice(0, MAX_LENGTH.short);

/**
 * The target, resolved. A host pair must be in the offer list of one of the caller's own paired, online computers;
 * a model must be one a send may use now. Throws a coded refusal otherwise, before anything is written.
 */
const resolveTarget = async (ctx: MutationCtx, args: SwitchArgs, now: number): Promise<ResolvedTarget> => {
    const { target } = args;

    if (target.kind === "model") {
        const definition = requireEnabledModel(target.model, { mode: "text" }, "chat");

        await assertPaidModel(ctx, args.userId, definition);

        return { kind: "model", model: definition.id };
    }

    const device = await ctx.db.devices.findFirst({ where: { _id: target.hostId, userId: args.userId } });
    const offer = offerOf(device, target.agentKey, target.folderId);

    if (!device?.encryptedSecret || device.revokedAt !== undefined || !offer) {
        return refuse(AGENT_SWITCH_NOT_OFFERED, "That agent is not approved for that folder on this computer. Approve it in the desktop app first.");
    }

    if (!isDeviceOnline(device, now)) {
        return refuse(AGENT_SWITCH_HOST_OFFLINE, "That computer is not online.");
    }

    return { device, kind: "host", offer };
};

/** The agent a thread's turns run on now, for a divider's `from`: a host thread's newest session, a cloud thread's path. */
const currentAgent = async (ctx: MutationCtx, thread: Doc<"threads">, leaf: Doc<"messages">): Promise<{ agent: SwitchAgentRef; session?: Session } | null> => {
    if (!isHostRunThread(thread)) {
        const model = await resolvePathAgent(ctx, thread, leaf);

        return model && { agent: model };
    }

    const session = await sessionOfThread(ctx, thread._id);

    return session && { agent: sessionRefOf(session), session };
};

/**
 * The newest turns of the thread as the handoff text of a switch to `target`; empty when the thread has no turn with text.
 * A switch that reattaches the agent's own session (`lenient`) stores it only for the load that fails, so one too large to
 * hand over is left out rather than refusing a switch that does not need it.
 */
const handoffFor = async (
    ctx: MutationCtx,
    thread: Doc<"threads">,
    leaf: Doc<"messages">,
    target: ResolvedTarget,
    options: { lenient?: boolean } = {},
): Promise<string> => {
    const source = await collectHandoffSource(ctx, thread._id, leaf);
    // A cloud thread is sent its handoff as a message of its own, with the room a cloud handoff has anywhere; a computer is
    // sent it in front of the prompt, inside the signed call.
    const maxBytes = target.kind === "host" ? HOST_HANDOFF_MAX_BYTES : HANDOFF_BUDGET_TOKENS * CHARACTERS_PER_TOKEN;

    if (source.turns.length === 0) {
        // A thread that took over and has said nothing since holds the conversation only in its own handoff: pass that on.
        const carried = (await pendingHandoffOf(ctx, thread)) ?? "";

        if (jsonBytes(carried) <= maxBytes) {
            return carried;
        }

        return options.lenient ? "" : refuse(HANDOFF_REFUSED_TOO_LARGE, "The conversation handed over is too long to hand on again. Send a message first.");
    }

    try {
        return composeTailHandoff(source.turns, maxBytes, source.omittedEarlier);
    } catch (error) {
        if (error instanceof HandoffTooLargeError) {
            return options.lenient ? "" : refuse(error.code, error.message);
        }

        throw error;
    }
};

/** What a switch back to an agent with a saved session asks the computer to reattach, and what that session has missed. */
interface NativePlan {
    /** The turns since the agent left, as a delta handoff; empty when no other agent ran in between. */
    catchUp: string;
    nativeSessionId: string;
}

/**
 * The reattach of a host-to-host switch (harness switch S4): the same agent, folder and computer as an earlier session of this
 * thread that can load itself again. That session has seen the thread up to where the agent left and nothing after, so
 * whatever another agent did since goes with the first prompt as a delta. Nothing to reattach to, or what it missed
 * cannot be told (the divider it left through is gone, or the turns do not fit), is `undefined`: the switch hands the
 * whole conversation over instead.
 */
const nativePlanFor = async (
    ctx: MutationCtx,
    args: { current: { agent: SwitchAgentRef }; leaf: Doc<"messages">; target: ResolvedTarget; thread: Doc<"threads">; to: SwitchAgentRef },
): Promise<NativePlan | undefined> => {
    const { current, leaf, target, thread, to } = args;

    if (target.kind !== "host" || !isHostRunThread(thread)) {
        return undefined;
    }

    const { page: earlier } = await ctx.db.acpSessions.findMany({ orderBy: [{ _creationTime: "desc" }], where: { threadId: thread._id } });
    const saved = savedSessionFor(earlier, { agentKey: target.offer.agentKey, deviceId: target.device._id, folderId: target.offer.folderId });

    if (saved?.nativeSessionId === undefined) {
        return undefined;
    }

    // The agent's session just ended, with nobody else having run since: it has seen everything.
    if (sameAgent(current.agent, to)) {
        return { catchUp: "", nativeSessionId: saved.nativeSessionId };
    }

    const departure = await findDividerLeaving(ctx, thread._id, leaf, agentKeyOf(to));

    if (!departure) {
        return undefined;
    }

    const missed = await collectHandoffSource(ctx, thread._id, leaf, { stopAtId: departure.part.startMessageId });

    if (missed.turns.length === 0) {
        return { catchUp: "", nativeSessionId: saved.nativeSessionId };
    }

    try {
        return { catchUp: composeTailHandoff(missed.turns, HOST_HANDOFF_MAX_BYTES, missed.omittedEarlier, "delta"), nativeSessionId: saved.nativeSessionId };
    } catch (error) {
        if (error instanceof HandoffTooLargeError) {
            return undefined;
        }

        throw error;
    }
};

/**
 * Inserts the first row of a thread that takes over from another: a `portable` divider holding the handoff. It follows
 * no row of its own thread, so it names itself as the row it follows (written once the row has an id).
 */
const insertFirstDivider = async (
    ctx: MutationCtx,
    args: { forkId: Id<"threads">; from: SwitchAgentRef; handoff: string; to: SwitchAgentRef; userId: string },
): Promise<Id<"messages">> => {
    const part = { from: args.from, mode: "portable" as const, to: args.to, ...(args.handoff && { handoff: args.handoff }) };
    const messageId = await insertAgentSwitchRow(ctx.db, { order: 0, part: { ...part, startMessageId: "first" }, threadId: args.forkId, userId: args.userId });

    await patchAgentSwitchRow(ctx.db, messageId, { ...part, startMessageId: messageId });

    return messageId;
};

/** Continuation relationships read per page when a repeated click looks for its thread, and the pages it may read. */
const CLICK_LOOKUP_PAGE = 50;
const CLICK_LOOKUP_PAGES = 20;

/** The thread a repeated click already made, for a switch that forks. */
const forkOfEarlierClick = async (
    ctx: MutationCtx,
    args: { claimedAt: number; clientId: string; target: SwitchArgs["target"]; thread: Doc<"threads">; userId: string },
): Promise<string | undefined> => {
    if (args.target.kind === "host") {
        const hostSessionId = await webSessionId(args.userId, args.clientId, { kind: "switch", threadId: args.thread._id });
        const first = await ctx.db.acpSessions.findFirst({ where: { deviceId: args.target.hostId, hostSessionId } });

        return first?.threadId as string | undefined;
    }

    // The claim is taken last, in the transaction that made the thread: the newest child at or before it is this click's,
    // however many later switches from the same thread sit in front of it.
    let cursor: string | undefined;

    for (let pages = 0; pages < CLICK_LOOKUP_PAGES; pages += 1) {
        const { continueCursor, isDone, page } = await ctx.db.threadRelationships.findMany({
            cursor,
            limit: CLICK_LOOKUP_PAGE,
            orderBy: [{ _creationTime: "desc" }],
            where: { branchType: "continuation", parentThreadId: args.thread._id },
        });
        const hit = page.find((relationship) => relationship._creationTime <= args.claimedAt);

        if (hit) {
            return hit.threadId as string;
        }

        if (isDone) {
            return undefined;
        }

        cursor = continueCursor ?? undefined;
    }

    return undefined;
};

/** What a repeated click answers: nothing more happened. */
const ALREADY = (agent: SwitchAgentRef, forkedThreadId?: string): SwitchResult => {
    return { agent, coldStartCostly: false, messageId: null, switched: false, ...(forkedThreadId !== undefined && { forkedThreadId }) };
};

/**
 * What a repeated click answers: nothing more happened. A switch that forked is answered with the thread it made and the
 * agent that thread runs, read back from the thread itself, so a computer that has since gone offline, or lost the offer,
 * does not turn a retry into a refusal. A click id reused for another agent is refused rather than answered with the
 * first one's thread.
 */
const answerRepeatedClick = async (
    ctx: MutationCtx,
    args: {
        claimedAt: number;
        clientId: string;
        current: SwitchAgentRef;
        forks: boolean;
        target: SwitchArgs["target"];
        thread: Doc<"threads">;
        userId: string;
    },
): Promise<SwitchResult> => {
    const forkedThreadId = args.forks ? await forkOfEarlierClick(ctx, args) : undefined;

    if (forkedThreadId === undefined) {
        return ALREADY(args.current);
    }

    const forkId = ctx.db.normalizeId("threads", forkedThreadId);
    const session = args.target.kind === "host" && forkId ? await sessionOfThread(ctx, forkId) : null;
    const fork = forkId ? await ctx.db.threads.findFirst({ where: { _id: forkId } }) : null;

    if (args.target.kind === "model") {
        if (fork?.activeAgent?.model !== args.target.model) {
            return refuse(AGENT_SWITCH_UNSUPPORTED, "That switch was already made for a different agent");
        }

        return ALREADY({ kind: "model", model: args.target.model }, forkedThreadId);
    }

    if (!session || session.agentKey !== args.target.agentKey || session.folderId !== args.target.folderId || session.deviceId !== args.target.hostId) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "That switch was already made for a different agent");
    }

    return ALREADY(sessionRefOf(session), forkedThreadId);
};

export interface HostSwitchArgs extends SwitchArgs {
    unlockProof?: string;
}

/** `commitHostSwitch`'s body, with the caller passed in so the harness can drive it. */
export const commitHostSwitchHandler = async (ctx: MutationCtx, args: HostSwitchArgs): Promise<SwitchResult> => {
    const now = Date.now();
    const { thread } = await requireThreadPermission(ctx, args.threadId, args.userId, "write", args.unlockProof);

    if (thread.userId !== args.userId) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "Only the owner of a chat can hand it to or from a coding agent");
    }

    // Guests have no computers, and are pinned to the free model whatever a send names.
    const caller = await getUser(ctx, args.userId);

    if (caller?.isAnonymous === true) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "Guests run on the free model");
    }

    const fromHost = isHostRunThread(thread);

    if (!fromHost && (hasFixedAgent(thread) || args.target.kind === "model")) {
        // A cloud model on a cloud thread is the model switch's (`chat/agent-switch.ts`).
        return refuse(AGENT_SWITCH_UNSUPPORTED, hasFixedAgent(thread) ? "This chat runs on a fixed agent" : "Not a coding-agent switch");
    }

    const leaf = await leafRowOf(ctx, thread);
    const current = leaf ? await currentAgent(ctx, thread, leaf) : null;

    if (!leaf || !current) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "There is nothing to switch from yet");
    }

    const claimKey = claimKeyOf(args);
    const claimedAt = await claimedAtOf(ctx, "switch", claimKey);
    // Across the runner, as opposed to host to host, which stays in the thread.
    const toHost = args.target.kind === "host";
    const forks = fromHost !== toHost;

    // A click already answered: the same answer, not a second thread. Before the target is looked up, which needs the
    // computer to be online and to still offer the pair.
    if (claimedAt !== null) {
        return await answerRepeatedClick(ctx, {
            claimedAt,
            clientId: args.clientId,
            current: current.agent,
            forks,
            target: args.target,
            thread,
            userId: args.userId,
        });
    }

    const target = await resolveTarget(ctx, args, now);
    const to: SwitchAgentRef = target.kind === "host" ? hostRefOf(target.device._id as string, target.offer) : { kind: "model", model: target.model };

    if (fromHost) {
        if (await liveHostStream(ctx, thread._id)) {
            throw new LunoraError("CONFLICT", "Wait for the reply to finish, or stop it, before switching", { data: { code: AGENT_SWITCH_STREAMING } });
        }

        // A session still opening, or a turn the computer has not reported back, is not a place to leave from.
        if (current.session?.status === "starting" || current.session?.status === "busy") {
            throw new LunoraError("CONFLICT", "Wait for the agent to be ready before switching", { data: { code: AGENT_SWITCH_STREAMING } });
        }
    } else {
        await assertNotStreaming(ctx, thread);
    }

    // The same agent in the same folder on the same computer, while its session is alive: nothing to switch.
    if (target.kind === "host" && fromHost && current.session?.status !== "ended" && sameAgent(current.agent, to)) {
        await claimOnce(ctx, "switch", claimKey, AGENT_SWITCH_CLAIM_TTL_MS, args.userId);

        return ALREADY(current.agent);
    }

    // Both ways of reaching a computer start something on it: a host target and a thread that takes over from one draw on
    // the same budget a direct start does (`hosts/start`, one limit for both plans).
    if (target.kind === "host") {
        const limited = await checkRateLimit(ctx, "hosts/start:free", { key: args.userId });

        if (!limited.ok) {
            throw new LunoraError("TOO_MANY_REQUESTS", "Too many coding agents were started in a short while. Try again in a minute.");
        }
    }

    const native = await nativePlanFor(ctx, { current, leaf, target, thread, to });
    const handoff = await handoffFor(ctx, thread, leaf, target, { lenient: native !== undefined });
    const taintedBy = target.kind === "host" ? await takeoverTaint(ctx, { current, fromHost, leaf, thread }) : [];
    const result = await write(ctx, { clientId: args.clientId, current, handoff, leaf, native, now, taintedBy, target, thread, to, userId: args.userId });

    if (!(await claimOnce(ctx, "switch", claimKey, AGENT_SWITCH_CLAIM_TTL_MS, args.userId))) {
        // Another click took it between the check and here: this transaction's writes go with the throw.
        throw new LunoraError("CONFLICT", "This switch was already made", { data: { code: AGENT_SWITCH_STREAMING } });
    }

    ctx.log.event("acp.agent_switch", { forked: result.forkedThreadId !== undefined, from: current.agent.kind, to: to.kind });

    return result;
};

/**
 * What the agent that takes over has been handed that came from outside: it can run commands on the computer, so every
 * prompt it is sent is signed with it (`/hosts/send`). From a cloud thread that is what the thread read; from another
 * agent it is what that agent carried plus the pages and files it read on the computer, which are in none of this
 * thread's rows (as `HOST_HANDOFF_TAINT` says for the way back).
 */
const takeoverTaint = async (
    ctx: MutationCtx,
    args: { current: { session?: Session }; fromHost: boolean; leaf: Doc<"messages">; thread: Doc<"threads"> },
): Promise<DeviceTaintSource[]> =>
    args.fromHost ? mergeTaint(args.current.session?.taintedBy, HOST_HANDOFF_TAINT) : await threadPathTaint(ctx, args.thread._id, args.leaf);

interface WriteArgs {
    clientId: string;
    current: { agent: SwitchAgentRef; session?: Session };
    handoff: string;
    leaf: Doc<"messages">;
    native: NativePlan | undefined;
    now: number;
    taintedBy: DeviceTaintSource[];
    target: ResolvedTarget;
    thread: Doc<"threads">;
    to: SwitchAgentRef;
    userId: string;
}

/** Throws the refusal an `acp_start` the computer cannot take is, so the transaction's writes are rolled back. */
const startOn = async (
    ctx: MutationCtx,
    args: {
        clientId: string;
        device: Device;
        nativeSessionId?: string;
        now: number;
        offer: Offer;
        /** The thread the click was made on, which keys the session id; the session itself opens in `threadId`. */
        sourceThreadId: Id<"threads">;
        taintedBy: DeviceTaintSource[];
        threadId: Id<"threads">;
        userId: string;
    },
) => {
    const hostSessionId = await webSessionId(args.userId, args.clientId, { kind: "switch", threadId: args.sourceThreadId });
    const call = await startHostSessionIn(
        ctx,
        {
            device: args.device,
            hostSessionId,
            ...(args.nativeSessionId !== undefined && { nativeSessionId: args.nativeSessionId }),
            offer: args.offer,
            taintedBy: args.taintedBy,
            threadId: args.threadId,
            userId: args.userId,
        },
        args.now,
    );

    if ("error" in call) {
        throw new LunoraError("BAD_REQUEST", startFailureMessage(call.error));
    }
};

const write = async (ctx: MutationCtx, args: WriteArgs): Promise<SwitchResult> => {
    const { current, handoff, leaf, native, now, taintedBy, target, thread, to, userId } = args;

    // Host to host: the thread and its runner stay; the session it ran in ends and the next one opens in it.
    if (target.kind === "host" && isHostRunThread(thread)) {
        // The agent reattaches to its own session (`native`); the portable handoff is stored all the same, for the load that fails.
        const part = {
            ...(native?.catchUp && { catchUp: native.catchUp }),
            from: current.agent,
            mode: native ? ("native" as const) : ("portable" as const),
            startMessageId: leaf._id,
            to,
            ...(handoff && { handoff }),
        };

        await startOn(ctx, {
            clientId: args.clientId,
            device: target.device,
            ...(native && { nativeSessionId: native.nativeSessionId }),
            now,
            offer: target.offer,
            sourceThreadId: thread._id,
            taintedBy,
            threadId: thread._id,
            userId,
        });

        if (current.session && current.session.status !== "ended") {
            await ctx.db.patch(current.session._id, { status: "ended", updatedAt: now });
        }

        const last = await getMaxMessage(ctx, thread._id);
        const messageId = await insertAgentSwitchRow(ctx.db, {
            order: (last?.order ?? -1) + 1,
            ...(thread.activeLeafMessageId && { parentMessageId: leaf._id }),
            part,
            threadId: thread._id,
            userId,
        });

        await patchThread(ctx.db, thread._id, {
            model: target.offer.agentKey,
            updatedAt: now,
            ...(thread.activeLeafMessageId && { activeLeafMessageId: messageId }),
        });

        return { agent: to, coldStartCostly: false, messageId, switched: true };
    }

    // Across the runner: a new thread that takes over, linked to this one, which stays exactly as it was.
    const forkId =
        target.kind === "host"
            ? await insertThread(ctx.db, {
                  createdBy: userId,
                  mode: "text",
                  model: target.offer.agentKey,
                  runner: "host",
                  status: "active",
                  tags: ["chat", "host"],
                  title: hostTitle(target.offer),
                  updatedAt: now,
                  userId,
              })
            : await insertThread(ctx.db, {
                  activeAgent: { kind: "model", model: target.model },
                  createdBy: userId,
                  ...(handoff && { hasHandoff: true }),
                  mode: "text",
                  model: target.model,
                  status: "active",
                  tags: ["chat"],
                  title: thread.title ?? "",
                  updatedAt: now,
                  userId,
              });

    if (target.kind === "host") {
        await startOn(ctx, {
            clientId: args.clientId,
            device: target.device,
            now,
            offer: target.offer,
            sourceThreadId: thread._id,
            taintedBy,
            threadId: forkId,
            userId,
        });
    }

    await insertFirstDivider(ctx, { forkId, from: current.agent, handoff, to, userId });
    await insertThreadRelationship(ctx.db, { branchType: "continuation", createdAt: now, parentThreadId: thread._id, threadId: forkId, userId });

    return { agent: to, coldStartCostly: false, forkedThreadId: forkId as string, messageId: null, switched: true };
};

/** Whether a switch of this thread is the host switch's: the thread runs on a computer. A fact about the thread, not a permission. */
export const isHostSwitchSource = internalQuery
    .input({ threadId: v.id("threads") })
    .output(v.boolean())
    .query(async ({ args, ctx }) => isHostRunThread(await ctx.db.threads.findFirst({ where: { _id: args.threadId } })));

export const commitHostSwitch = internalMutation
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        target: vSwitchTarget,
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            agent: vSwitchAgentRef,
            coldStartCostly: v.boolean(),
            forkedThreadId: v.optional(v.string()),
            messageId: v.union(v.string(), v.null()),
            switched: v.boolean(),
        }),
    )
    .mutation(async ({ args, ctx }) => await commitHostSwitchHandler(ctx, args));
