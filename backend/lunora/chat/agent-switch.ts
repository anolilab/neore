/**
 * Switching a thread's agent mid-conversation (plans/harness-switch.md, slices S1 and S2: cloud models).
 *
 * `switchThreadAgent` records the change as one divider row in the transcript
 * (`agent/agent-switch-logic.ts`); the next turn runs on the model the active path ends on
 * (`agent/agent-switch.ts`). What the new model is given is the divider's `mode`: the whole path
 * (`full`), or a handoff — a summary of the older turns plus the recent ones verbatim (`agent/handoff.ts`) —
 * built once here and stored on the divider so every later turn sends the same bytes.
 *
 * Three steps, because the summary needs the gateway (actions only) and the write needs a transaction:
 * `planAgentSwitch` (a query) checks the switch and reads what the handoff is built from, the action
 * writes the summary — uncharged, nothing is saved yet — and `commitAgentSwitch` (one mutation) takes the
 * claim-once, charges the round and writes the divider, so a write that fails takes the claim and the
 * charge with it and the retry is not refused.
 *
 * The summary is the one call made before the charge, so it is fenced instead: the plan refuses a user whose
 * daily allowance is spent, `beginSwitchSummary` lets one summary run per thread at a time and counts it
 * against its own rate limit, and only then does the action call the gateway.
 */
import { PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { generateText } from "ai";
import { LunoraError, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { isHostRunThread } from "../acp/lib/host-thread";
import { leafRowOf, pathExceedsColdStart, resolvePathAgent } from "../agent/agent-switch";
import { sameAgent } from "../agent/agent-switch-logic";
import { type AgentRef, HANDOFF_MAX_CHARACTERS, vAgentRef, vAgentSwitchMode } from "../agent/agent-switch-validators";
import {
    assertWithinBudget,
    capSummary,
    composeHandoff,
    HANDOFF_BUDGET_TOKENS,
    HANDOFF_SUMMARY_MAX_TOKENS,
    HANDOFF_SUMMARY_SYSTEM,
    HandoffTooLargeError,
    planHandoff,
    summaryPromptOf,
    type HandoffKind,
    type HandoffTurn,
} from "../agent/handoff";
import { collectHandoffSource, findDividerLeaving, pathTokens, rowsSince } from "../agent/handoff-source";
import { getMaxMessage } from "../agent/messages";
import { DEFAULT_RECENT_MESSAGES } from "../agent/shared";
import { insertAgentSwitchRow, patchThread } from "../agent/table-writes";
import { requireThreadPermission } from "../agent/thread-read-access";
import { hasLiveDeltaStream, hasStreamFor, hasUnsettledStop, isThreadStreaming } from "../agent/thread-streaming";
import { getUser } from "../auth/lib/better-auth-queries";
import { claimFence, claimOnce, hasClaim, releaseClaim } from "../lib/claim-once";
import { authAction, authQuery, rateLimit } from "../lib/crpc";
import { createRatelimit } from "../lib/rate-limiter";
import { systemDb } from "../lib/rls/scope";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { chargeRound, hasRoundAllowance, loadTaskAccount } from "../tasks/account";
import { assertPaidModel, requireEnabledModel } from "./lib/enabled-model";
import { findPendingApprovalOnLatestTurn } from "./lib/tool-approval-claim";

/** Approval requests checked for being open on the latest turn — the newest few, never the thread's history. */
const RECENT_APPROVALS_CHECKED = 5;

/**
 * Whether the latest turn waits on a tool approval or a question (`toolApprovalRuns`). Answering it resumes the
 * paused reply on its stored model and hangs the continuation under that reply, past a divider written in between.
 * Read past RLS: the run is stored under the thread's owner, so a collaborator with a write grant would see none.
 * A decision only — no row leaves this function.
 */
const hasOpenApproval = async (ctx: QueryCtx, threadId: Id<"threads">): Promise<boolean> => {
    const runs = await systemDb(ctx)
        .query("toolApprovalRuns")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("desc")
        .take(RECENT_APPROVALS_CHECKED);

    for (const run of runs) {
        // A request the conversation moved past is stale and blocks nothing.
        if (run.status === "pending" && (await findPendingApprovalOnLatestTurn(ctx, threadId, run.approvalId))) {
            return true;
        }
    }

    return false;
};

/** Why a switch was refused, for the client to word: the `data.code` of the error. */
export const AGENT_SWITCH_STREAMING = "AGENT_SWITCH_STREAMING";
export const AGENT_SWITCH_UNSUPPORTED = "AGENT_SWITCH_UNSUPPORTED";
/** The conversation moved on between the plan and the write; the handoff would describe a different path. */
export const AGENT_SWITCH_STALE = "AGENT_SWITCH_STALE";
export const AGENT_SWITCH_SUMMARY_FAILED = "AGENT_SWITCH_SUMMARY_FAILED";
export const AGENT_SWITCH_LIMIT = "AGENT_SWITCH_LIMIT";
/** Another summary for this thread is being written; the switch it prepares is the one that counts. */
export const AGENT_SWITCH_BUSY = "AGENT_SWITCH_BUSY";
/** Too many summaries in a short while (`chat/agentSwitchSummary`). */
export const AGENT_SWITCH_RATE_LIMITED = "AGENT_SWITCH_RATE_LIMITED";

/**
 * A `clientId` is remembered this long. A double tap is over in seconds; the rest is for a stale
 * click replayed after later switches, which must not undo them.
 */
const AGENT_SWITCH_CLAIM_TTL_MS = 10 * 60 * 1000;

/** A summary call takes seconds; the claim outlasts a slow one and frees the thread soon after an action that died holding it. */
const AGENT_SWITCH_SUMMARY_CLAIM_TTL_MS = 2 * 60 * 1000;
const SUMMARY_CLAIM_SCOPE = "switch-summary";

/** The preview counts a conversation up to this many tokens; past it the figure is "at least". */
const PREVIEW_TOKEN_CAP = 250_000;

const refuse = (code: string, message: string): never => {
    throw new LunoraError("BAD_REQUEST", message, { data: { code } });
};

const limitReached = (): LunoraError =>
    new LunoraError(
        "TOO_MANY_REQUESTS",
        "You've reached your daily message limit, so the conversation cannot be summarised. Keep the full history, or try again tomorrow.",
        { data: { code: AGENT_SWITCH_LIMIT } },
    );

interface SwitchResult {
    agent: AgentRef;
    /** The conversation is long enough that the next reply re-reads it without the provider's cache (`PROMPT_CACHE_COLD_START_TOKENS`). */
    coldStartCostly: boolean;
    messageId: string | null;
    switched: boolean;
}

type SwitchTarget = { kind: "host" } | { kind: "model"; model: string };

interface SwitchArgs {
    clientId: string;
    target: SwitchTarget;
    threadId: Id<"threads">;
    unlockProof?: string;
    userId: string;
}

/** The handoff an action built, as the write takes it. */
interface StoredHandoff {
    mode: "delta" | "portable";
    /** The text holds a model's summary: the write charges the round for it. */
    summarized: boolean;
    /** Empty for a switch back with nothing missed: the divider stores no handoff and the model sees what it saw. */
    text: string;
}

/** The part of a switch the user can ask for; the server decides between `portable` and `delta`. */
type RequestedMode = "full" | "portable";

const vSwitchTarget = v.union(
    v.object({ kind: v.literal("model"), model: v.string().max(MAX_LENGTH.short) }),
    // Offered host agents arrive with the host slices; the shape is accepted so a refusal can be typed.
    v.object({ kind: v.literal("host") }),
);

const vRequestedMode = v.union(v.literal("full"), v.literal("portable"));

type Checked = { agent: AgentRef; kind: "same" } | { from: AgentRef; kind: "ready"; leaf: Doc<"messages">; thread: Doc<"threads">; to: AgentRef };

/** Everything that decides whether a switch may happen, before anything is claimed or written. */
const checkSwitch = async (ctx: QueryCtx, args: SwitchArgs): Promise<Checked> => {
    // The right a collaborator already has to pick the model of a send.
    const { thread } = await requireThreadPermission(ctx, args.threadId, args.userId, "write", args.unlockProof);

    // Guests are pinned to the free model whatever a send names (`/chat/start`), so there is no agent to switch.
    const caller = await getUser(ctx, args.userId);

    if (caller?.isAnonymous === true) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "Guests run on the free model");
    }

    if (args.target.kind !== "model") {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "Switching to a host agent is not available yet");
    }

    // A bot runs on its bot's model, a group chat on its participants, a messenger thread on the connection's,
    // a coding-agent thread on its host, and a media thread has no model to swap.
    if (
        thread.botId ||
        thread.groupChat ||
        thread.multiChat ||
        thread.messengerConnectionId ||
        isHostRunThread(thread) ||
        (thread.mode !== undefined && thread.mode !== "text")
    ) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "This chat runs on a fixed agent");
    }

    // Checked again when the turn runs: a plan can change in between.
    const definition = requireEnabledModel(args.target.model, { mode: "text" }, "chat");

    await assertPaidModel(ctx, args.userId, definition);

    // Every later send runs on the switched model under its own sender's plan, the owner's included: a model the
    // owner cannot run would leave their next send refused (`plan-required`) with no fallback.
    if (thread.userId !== undefined && thread.userId !== args.userId) {
        await assertPaidModel(ctx, thread.userId, definition);
    }

    // A hard rule, so a transcript never has two agents writing at once.
    if ((await isThreadStreaming(ctx, thread._id)) || (await hasLiveDeltaStream(ctx, thread._id)) || (await hasUnsettledStop(ctx, thread._id, Date.now()))) {
        throw new LunoraError("CONFLICT", "Wait for the reply to finish, or stop it, before switching", { data: { code: AGENT_SWITCH_STREAMING } });
    }

    if (await hasOpenApproval(ctx, thread._id)) {
        throw new LunoraError("CONFLICT", "Answer the pending request before switching", { data: { code: AGENT_SWITCH_STREAMING } });
    }

    const leaf = await leafRowOf(ctx, thread);
    const from = leaf && (await resolvePathAgent(ctx, thread, leaf));

    if (!leaf || !from) {
        return refuse(AGENT_SWITCH_UNSUPPORTED, "There is nothing to switch from yet");
    }

    const to: AgentRef = { kind: "model", model: definition.id };
    if (sameAgent(from, to)) {
        return { agent: from, kind: "same" };
    }

    // The prompt is saved before its stream exists: a divider written in that gap would sit under a prompt the
    // reply then hangs off, past the divider. A prompt whose run already started — and was stopped or failed
    // before a reply — is no gap, or the user could never leave the model that is not answering. (A regenerate's
    // gap, between pointing the leaf at its prompt and creating the stream, is milliseconds and stays open.)
    if ((leaf.message as { role?: string } | undefined)?.role === "user" && !(await hasStreamFor(ctx, thread._id, leaf._id))) {
        throw new LunoraError("CONFLICT", "Wait for the reply to start before switching", { data: { code: AGENT_SWITCH_STREAMING } });
    }

    return { from, kind: "ready", leaf, thread, to };
};

/** The claim key of one click: the caller's, not the thread's — the claims table is shared and a `clientId` is client-chosen. */
const claimKeyOf = (args: Pick<SwitchArgs, "clientId" | "threadId" | "userId">): string => `${args.userId}:${args.threadId}:${args.clientId}`;

/**
 * `switchThreadAgent`'s write, with the caller passed in so the harness can drive it. With no `handoff` the
 * divider is a `full` one (S1): the new model sees the whole path. `expectedLeafId` is the row the handoff was
 * built from; a conversation that moved on since is refused rather than described wrongly.
 */
export const switchThreadAgentHandler = async (
    ctx: MutationCtx,
    args: SwitchArgs & { expectedLeafId?: string; handoff?: StoredHandoff },
): Promise<SwitchResult> => {
    const checked = await checkSwitch(ctx, args);

    if (checked.kind === "same") {
        // Claimed too, so a stale replay of this pick cannot revert a switch made after it.
        await claimOnce(ctx, "switch", claimKeyOf(args), AGENT_SWITCH_CLAIM_TTL_MS, args.userId);

        return { agent: checked.agent, coldStartCostly: false, messageId: null, switched: false };
    }

    const { from, leaf, thread, to } = checked;

    if (args.expectedLeafId !== undefined && args.expectedLeafId !== leaf._id) {
        throw new LunoraError("CONFLICT", "The conversation changed while the switch was prepared. Try again.", { data: { code: AGENT_SWITCH_STALE } });
    }

    const claimed = await claimOnce(ctx, "switch", claimKeyOf(args), AGENT_SWITCH_CLAIM_TTL_MS, args.userId);

    if (!claimed) {
        return { agent: from, coldStartCostly: false, messageId: null, switched: false };
    }

    // The summary call was the only paid step. It is charged here, in the transaction that writes the divider:
    // a failed write takes the claim and the charge with it, and a retry after a success never gets this far.
    if (args.handoff?.summarized) {
        const account = await loadTaskAccount(ctx, args.userId);

        if (!account || !(await chargeRound(ctx, args.userId, account))) {
            throw limitReached();
        }
    }

    // Past every row, so a sibling branch's `order` is never reused; a branched thread also names its
    // parent, because the previous row in storage order may sit on another branch.
    const last = await getMaxMessage(ctx, thread._id);
    const order = (last?.order ?? -1) + 1;
    const messageId = await insertAgentSwitchRow(ctx.db, {
        order,
        ...(thread.activeLeafMessageId && { parentMessageId: leaf._id }),
        part: {
            from,
            ...(args.handoff?.text && { handoff: args.handoff.text, summarized: args.handoff.summarized }),
            mode: args.handoff?.mode ?? "full",
            startMessageId: leaf._id,
            to,
        },
        threadId: thread._id,
        userId: args.userId,
    });

    await patchThread(ctx.db, thread._id, {
        activeAgent: to,
        // The row now ends the path the thread displays.
        ...(thread.activeLeafMessageId && { activeLeafMessageId: messageId }),
        updatedAt: Date.now(),
    });

    ctx.log.event("chat.agent_switch", {
        from: from.model,
        mode: args.handoff?.mode ?? "full",
        summarized: args.handoff?.summarized ?? false,
        threadId: thread._id,
        to: to.model,
    });

    return { agent: to, coldStartCostly: await pathExceedsColdStart(ctx, thread._id, leaf), messageId, switched: true };
};

/**
 * What the handoff of a switch to `to` is built from, or the mode alone for `full`. Past the threshold a
 * switch hands over by default (the summary and the tail are smaller than the history); below it the new
 * model gets the whole path, as in S1. A switch back to a model that already saw part of the thread is a `delta`.
 */
const modeFor = async (
    ctx: QueryCtx,
    checked: Extract<Checked, { kind: "ready" }>,
    requested: RequestedMode | undefined,
): Promise<{ boundaryId?: string; contextTokens: number; mode: "delta" | "full" | "portable" }> => {
    const contextTokens = await pathTokens(ctx, checked.thread._id, checked.leaf, { cap: PREVIEW_TOKEN_CAP });
    const wanted = requested ?? (contextTokens > PROMPT_CACHE_COLD_START_TOKENS ? "portable" : "full");

    if (wanted === "full") {
        return { contextTokens, mode: "full" };
    }

    const earlier = await findDividerLeaving(ctx, checked.thread._id, checked.leaf, checked.to.model);

    // A model's earlier context is only sent while it is inside the context window; past it, a delta would tell the
    // model it had worked on a conversation of which it is given none.
    if (earlier && (await rowsSince(ctx, checked.thread._id, checked.leaf, earlier.part.startMessageId, DEFAULT_RECENT_MESSAGES)) < DEFAULT_RECENT_MESSAGES) {
        return { boundaryId: earlier.part.startMessageId, contextTokens, mode: "delta" };
    }

    return { contextTokens, mode: "portable" };
};

const vTurn = v.object({ role: v.union(v.literal("assistant"), v.literal("user")), text: v.string() });

const vPlan = v.object({
    agent: vAgentRef,
    /** Whether the daily limits have room for the round a summary is charged as; unset when the switch needs no summary call. */
    allowance: v.optional(v.boolean()),
    leafId: v.optional(v.string()),
    mode: v.optional(vAgentSwitchMode),
    omittedEarlier: v.optional(v.boolean()),
    turns: v.optional(v.array(vTurn)),
});

/** Whether handing these turns over takes a summary call. A thread too large to hand over is reported by the action. */
const needsSummary = (newestFirst: HandoffTurn[]): boolean => {
    try {
        return planHandoff(newestFirst).older.length > 0;
    } catch (error) {
        if (error instanceof HandoffTooLargeError) {
            return false;
        }

        throw error;
    }
};

/**
 * Step one: checks the switch and reads what a handoff is built from. Writes nothing and charges nothing.
 * `leafId` is the row it read the path at; the write refuses a path that has moved.
 */
export const planAgentSwitchHandler = async (
    ctx: QueryCtx,
    args: SwitchArgs & { mode?: RequestedMode },
): Promise<{
    agent: AgentRef;
    allowance?: boolean;
    leafId?: string;
    mode?: "delta" | "full" | "portable";
    omittedEarlier?: boolean;
    turns?: HandoffTurn[];
}> => {
    const checked = await checkSwitch(ctx, args);

    // A click already answered gets no second summary: the write would refuse it, and the model call is metered.
    if (checked.kind === "same" || (await hasClaim(ctx, "switch", claimKeyOf(args)))) {
        return { agent: checked.kind === "same" ? checked.agent : checked.from };
    }

    const { boundaryId, mode } = await modeFor(ctx, checked, args.mode);

    if (mode === "full") {
        return { agent: checked.from, leafId: checked.leaf._id, mode };
    }

    const source = await collectHandoffSource(ctx, checked.thread._id, checked.leaf, { stopAtId: boundaryId });
    const base = { agent: checked.from, leafId: checked.leaf._id, mode, omittedEarlier: source.omittedEarlier, turns: source.turns };

    if (!needsSummary(source.turns)) {
        return base;
    }

    // Read now, before the summary is paid for: the commit charges the round, but it comes after the call.
    const account = await loadTaskAccount(ctx, args.userId);

    return { ...base, allowance: account !== null && (await hasRoundAllowance(ctx, args.userId, account)) };
};

export const planAgentSwitch = internalQuery
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        mode: v.optional(vRequestedMode),
        target: vSwitchTarget,
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(vPlan)
    .query(async ({ args, ctx }) => await planAgentSwitchHandler(ctx, args));

const vSwitchResult = v.object({ agent: vAgentRef, coldStartCostly: v.boolean(), messageId: v.union(v.string(), v.null()), switched: v.boolean() });

/** Step three: the one transaction that claims the click, charges the summary and writes the divider. */
export const commitAgentSwitch = internalMutation
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        expectedLeafId: v.string(),
        handoff: v.optional(
            v.object({
                mode: v.union(v.literal("delta"), v.literal("portable")),
                summarized: v.boolean(),
                text: v.string().max(HANDOFF_MAX_CHARACTERS),
            }),
        ),
        target: vSwitchTarget,
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(vSwitchResult)
    .mutation(async ({ args, ctx }) => await switchThreadAgentHandler(ctx, args));

/**
 * Lets one summary call run for the thread and counts it against `chat/agentSwitchSummary`. Returns the
 * claim's fence for {@link releaseClaim}, or `null` when another summary of the thread is in flight, which is
 * not counted. A summary over the rate limit throws, taking the claim with it.
 */
export const beginSwitchSummaryHandler = async (ctx: MutationCtx, args: { threadId: Id<"threads">; userId: string }): Promise<number | null> => {
    const fence = await claimFence(ctx, SUMMARY_CLAIM_SCOPE, args.threadId, { ttlMs: AGENT_SWITCH_SUMMARY_CLAIM_TTL_MS, userId: args.userId });

    if (fence === null) {
        return null;
    }

    const account = await loadTaskAccount(ctx, args.userId);
    const { ok } = account ? await createRatelimit(`chat/agentSwitchSummary:${account.tier}`, ctx.db as never).limit(args.userId) : { ok: false };

    if (!ok) {
        await releaseClaim(ctx, SUMMARY_CLAIM_SCOPE, args.threadId, fence);

        throw new LunoraError(
            "TOO_MANY_REQUESTS",
            "Too many conversations were summarised in a short while. Try again in a minute, or keep the full history.",
            {
                data: { code: AGENT_SWITCH_RATE_LIMITED },
            },
        );
    }

    return fence;
};

export const beginSwitchSummary = internalMutation
    .input({ threadId: v.id("threads"), userId: v.string() })
    .output(v.union(v.null(), v.number()))
    .mutation(async ({ args, ctx }) => await beginSwitchSummaryHandler(ctx, args));

/** Writes the summary of `older`, or throws a refusal. Costs one utility-model call, metered by the gateway. */
export type Summarise = (older: HandoffTurn[], omittedEarlier: boolean) => Promise<string>;

const summariseWith =
    (ctx: Parameters<typeof gatewayFetch>[0], who: { threadId: string; userId: string }): Summarise =>
    async (older, omittedEarlier) => {
        try {
            const model = await getUtilityModel(gatewayFetch(ctx), who);
            const { text } = await generateText({
                maxOutputTokens: HANDOFF_SUMMARY_MAX_TOKENS,
                model,
                prompt: summaryPromptOf(older, omittedEarlier),
                system: HANDOFF_SUMMARY_SYSTEM,
                temperature: 0,
            });

            if (!text.trim()) {
                throw new Error("empty summary");
            }

            return text;
        } catch {
            throw new LunoraError("INTERNAL_SERVER_ERROR", "Could not summarise the conversation. Try again, or keep the full history.", {
                data: { code: AGENT_SWITCH_SUMMARY_FAILED },
            });
        }
    };

/** What `runAgentSwitch` needs of an action's context. Method syntax, so the real context's typed references fit. */
interface SwitchRunner {
    runMutation: (reference: unknown, args: unknown) => Promise<unknown>;
    runQuery: (reference: unknown, args: unknown) => Promise<unknown>;
}

type Plan = Awaited<ReturnType<typeof planAgentSwitchHandler>>;

/** The handoff text of a plan, summary included. `held` receives the summary claim's fence once it is taken. */
const buildHandoff = async (
    ctx: SwitchRunner,
    args: SwitchArgs,
    plan: Plan,
    kind: HandoffKind,
    summarise: Summarise,
    held: { fence: number | null },
): Promise<StoredHandoff> => {
    const turns = plan.turns ?? [];

    // Nothing happened since the model left: it is shown what it saw, and no message says so.
    if (kind === "delta" && turns.length === 0) {
        return { mode: kind, summarized: false, text: "" };
    }

    const { older, tail } = planHandoff(turns);

    if (older.length === 0) {
        return { mode: kind, summarized: false, text: assertWithinBudget(composeHandoff({ kind, tail })) };
    }

    if (plan.allowance === false) {
        throw limitReached();
    }

    const fence = (await ctx.runMutation(internal.chat.agent_switch.beginSwitchSummary, { threadId: args.threadId, userId: args.userId })) as number | null;

    if (fence === null) {
        throw new LunoraError("CONFLICT", "This conversation is already being prepared for a switch", { data: { code: AGENT_SWITCH_BUSY } });
    }

    held.fence = fence;

    const summary = capSummary(await summarise(older, plan.omittedEarlier === true));

    return { mode: kind, summarized: true, text: assertWithinBudget(composeHandoff({ kind, summary, tail })) };
};

/**
 * The action's body, with the summary call passed in so a test can drive it without the gateway. Plans,
 * builds the handoff (the summary first, fenced but not yet charged), then commits in one mutation.
 */
export const runAgentSwitch = async (ctx: SwitchRunner, args: SwitchArgs & { mode?: RequestedMode }, summarise: Summarise): Promise<SwitchResult> => {
    const plan = (await ctx.runQuery(internal.chat.agent_switch.planAgentSwitch, args)) as Plan;

    if (!plan.leafId || !plan.mode) {
        return { agent: plan.agent, coldStartCostly: false, messageId: null, switched: false };
    }

    const held: { fence: number | null } = { fence: null };

    try {
        const handoff = plan.mode === "full" ? undefined : await buildHandoff(ctx, args, plan, plan.mode, summarise, held);

        return (await ctx.runMutation(internal.chat.agent_switch.commitAgentSwitch, {
            clientId: args.clientId,
            expectedLeafId: plan.leafId,
            ...(handoff && { handoff }),
            target: args.target,
            threadId: args.threadId,
            unlockProof: args.unlockProof,
            userId: args.userId,
        })) as SwitchResult;
    } catch (error) {
        if (error instanceof HandoffTooLargeError) {
            return refuse(error.code, error.message);
        }

        throw error;
    } finally {
        if (held.fence !== null) {
            // After the commit, so a second click planned in between cannot summarise what this one is writing.
            // A claim that stays is freed by its TTL; it must not turn a finished switch into a failure.
            await ctx
                .runMutation(internal.lib.claim_once.releaseKey, { claimedAt: held.fence, key: args.threadId, scope: SUMMARY_CLAIM_SCOPE })
                .catch(() => undefined);
        }
    }
};

export const switchThreadAgent = authAction
    .use(rateLimit("chat/update"))
    .input({
        clientId: v.string().max(MAX_LENGTH.id),
        /** `full` keeps the whole history; unset lets the server decide by the conversation's size. */
        mode: v.optional(vRequestedMode),
        target: vSwitchTarget,
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(vSwitchResult)
    .action(async ({ args, ctx }) => {
        const { userId } = ctx.user;

        // The references are this file's own, so typing them here would make the generated api depend on its own output.
        const runner: SwitchRunner = {
            runMutation: async (reference, runArgs) => await ctx.runMutation(reference as never, runArgs as never),
            runQuery: async (reference, runArgs) => await ctx.runQuery(reference as never, runArgs as never),
        };

        return await runAgentSwitch(runner, { ...args, userId }, summariseWith(ctx, { threadId: args.threadId, userId }));
    });

interface SwitchPreview {
    /** Switching to this model changes nothing. */
    alreadyThere: boolean;
    coldStartCostly: boolean;
    /** What the next reply reads if the whole history is kept. */
    contextTokens: number;
    /** What the server chooses without being asked: `portable` above the threshold, else `full`. */
    defaultMode: "full" | "portable";
    /** What the next reply reads after a handoff: the handoff budget at most, plus what a switch back keeps. */
    handoffTokens: number;
}

/**
 * What a switch to `model` would cost, for the confirm step that comes before it. Token figures are the
 * 4-characters estimate the cold-start notice uses; the client turns them into credits with the target's price.
 */
export const previewAgentSwitchHandler = async (ctx: QueryCtx, args: Omit<SwitchArgs, "clientId" | "target"> & { model: string }): Promise<SwitchPreview> => {
    const checked = await checkSwitch(ctx, {
        clientId: "preview",
        target: { kind: "model", model: args.model },
        threadId: args.threadId,
        unlockProof: args.unlockProof,
        userId: args.userId,
    });

    if (checked.kind === "same") {
        return { alreadyThere: true, coldStartCostly: false, contextTokens: 0, defaultMode: "full", handoffTokens: 0 };
    }

    const { boundaryId, contextTokens } = await modeFor(ctx, checked, "portable");
    const sinceTokens = boundaryId ? await pathTokens(ctx, checked.thread._id, checked.leaf, { cap: PREVIEW_TOKEN_CAP, stopAtId: boundaryId }) : contextTokens;
    // A switch back keeps what the model saw and hands over only what came since; a first handoff is the whole of it.
    const handoffTokens = contextTokens - sinceTokens + Math.min(sinceTokens, HANDOFF_BUDGET_TOKENS);
    const coldStartCostly = contextTokens > PROMPT_CACHE_COLD_START_TOKENS;

    return { alreadyThere: false, coldStartCostly, contextTokens, defaultMode: coldStartCostly ? "portable" : "full", handoffTokens };
};

export const previewAgentSwitch = authQuery
    .input({
        model: v.string().max(MAX_LENGTH.short),
        threadId: v.id("threads"),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
    })
    .output(
        v.object({
            alreadyThere: v.boolean(),
            coldStartCostly: v.boolean(),
            contextTokens: v.number(),
            defaultMode: v.union(v.literal("full"), v.literal("portable")),
            handoffTokens: v.number(),
        }),
    )
    .query(async ({ args, ctx }) => await previewAgentSwitchHandler(ctx, { ...args, userId: ctx.user.userId }));
