/**
 * A thread's agent, derived from its active path.
 *
 * A switch leaves one `agentSwitch` row in the transcript (`agent-switch-logic.ts`). The agent a
 * turn runs on is the `to` of the LAST such row on the path that turn continues, or the thread's
 * creation model when the path has none — so moving to a sibling branch restores that branch's
 * agent with no write, and a regenerate of an older message runs on what was recorded on ITS path.
 *
 * `threads.activeAgent` caches the active path's agent for the thread list and the composer's
 * first paint, and doubles as the "was ever switched" flag: a thread without it keeps every send's
 * own model and pays for no walk. The derived value wins whenever they differ.
 */
import { PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { agentSwitchOf, lastAgentSwitch, sameAgent } from "./agent-switch-logic";
import type { AgentRef, AgentSwitchPart } from "./agent-switch-validators";
import { childrenOf, getThreadRow, parentOf, resolveLeafRow, walkPath } from "./branch-rows";
import { findDividerLeaving, findPathHandoff, pathTokens } from "./handoff-source";
import { getMaxMessage, pinFollowingRowParent } from "./messages";
import { insertAgentSwitchRow, patchAgentSwitchRow, patchThread } from "./table-writes";

type Row = Doc<"messages">;
type Reader = Pick<QueryCtx, "db">;

/** Rows read per step of a path walk: a switch is usually near the end, so most walks end in the first. */
const PATH_PAGE_ROWS = 100;

/** The row a new prompt would hang off: the displayed leaf, or the last row of a thread that never branched. */
export const leafRowOf = async (context: QueryCtx, thread: Doc<"threads">): Promise<Row | null> =>
    thread.activeLeafMessageId ? await resolveLeafRow(context, thread._id, thread.activeLeafMessageId) : await getMaxMessage(context, thread._id);

/** The newest switch on the path ending at `from` (inclusive), walking up a page at a time. */
const findPathSwitch = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<AgentSwitchPart | undefined> => {
    let cursor = from;

    while (cursor) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PATH_PAGE_ROWS });
        const found = lastAgentSwitch(rows);

        if (found) {
            return found;
        }

        cursor = next;
    }

    return undefined;
};

/** Every switch row of the path ending at `from` (inclusive) with its part, newest first. */
const findPathSwitchRows = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<{ part: AgentSwitchPart; row: Row }[]> => {
    const found: { part: AgentSwitchPart; row: Row }[] = [];
    let cursor = from;

    while (cursor) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PATH_PAGE_ROWS });

        for (const row of rows) {
            const part = agentSwitchOf(row);

            if (part) {
                found.push({ part, row });
            }
        }

        cursor = next;
    }

    return found;
};

/**
 * The agent the path ending at `from` (inclusive) runs on, or `null` when it has no switch and the
 * thread has no creation model. A thread without `activeAgent` was never switched — no divider
 * exists on any path — so it skips the walk, which would cost an unswitched path its whole length.
 */
export const resolvePathAgent = async (context: Reader, thread: Doc<"threads">, from: Row | null): Promise<AgentRef | null> => {
    const found = thread.activeAgent ? await findPathSwitch(context, thread._id, from) : undefined;

    if (found) {
        return found.to;
    }

    return thread.model ? { kind: "model", model: thread.model } : null;
};

/** Pages of {@link PATH_PAGE_ROWS} rows read before the path counts as long without reading further. */
const MAX_COLD_START_PAGES = 30;

/**
 * Whether the path ending at `from` is long enough that a model change re-sends a cold prompt worth
 * warning about (`PROMPT_CACHE_COLD_START_TOKENS`). Counts the stored text of each row with the
 * shared characters-per-token estimate, and stops as soon as the answer is yes.
 */
export const pathExceedsColdStart = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<boolean> =>
    (await pathTokens(context, threadId, from, { cap: PROMPT_CACHE_COLD_START_TOKENS, maxPages: MAX_COLD_START_PAGES })) > PROMPT_CACHE_COLD_START_TOKENS;

/** Delta dividers followed down to what their own target saw; a chain longer than this stands in as far as it got. */
const MAX_HANDOFF_DEPTH = 4;

/**
 * What stands in for the thread through `from` (inclusive) once the rows themselves have left the context
 * window: the stored handoff of the newest divider that carries one. A `portable` handoff covers everything
 * before it; a `delta` handoff covers what its agent missed, so it comes after what that agent saw.
 */
const handoffBlocksAt = async (context: Reader, threadId: Id<"threads">, from: Row | null, depth: number): Promise<string[]> => {
    const found = await findPathHandoff(context, threadId, from);

    if (!found?.part.handoff) {
        return [];
    }

    const { handoff, mode } = found.part;

    return mode === "delta" && depth > 0 ? [...(await deltaBase(context, threadId, found.part, depth - 1)), handoff] : [handoff];
};

/** What the target of the `delta` divider `part` saw when it left: the stand-in for the thread through its earlier divider, `[]` when it has none. */
const deltaBase = async (context: Reader, threadId: Id<"threads">, part: AgentSwitchPart, depth: number): Promise<string[]> => {
    const start = await getThreadRow(context, threadId, part.startMessageId);
    const earlier = start && (await findDividerLeaving(context, threadId, start, part.to.model));

    // The earlier divider's own handoff describes the thread up to the point the model left.
    return earlier ? await handoffBlocksAt(context, threadId, earlier.row, depth) : [];
};

/**
 * The stored handoffs a context window needs when it starts below the divider that holds them, oldest first,
 * for the rows above `belowMessageId`. Empty for a thread no switch ever stored a handoff on — never switched,
 * or switched only with its full history — at the cost of one thread read.
 */
export const handoffAboveOf = async (context: QueryCtx, args: { belowMessageId: Id<"messages">; threadId: Id<"threads"> }): Promise<string[]> => {
    const thread = await context.db.get(args.threadId);

    if (!thread?.activeAgent || !thread.hasHandoff) {
        return [];
    }

    const below = await getThreadRow(context, args.threadId, args.belowMessageId);
    const from = below && (await parentOf(context, args.threadId, below));

    return await handoffBlocksAt(context, args.threadId, from, MAX_HANDOFF_DEPTH);
};

export const getHandoffAbove = internalQuery
    .input({ belowMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => await handoffAboveOf(ctx, args));

/**
 * What the target of the `delta` divider `dividerMessageId` saw before it left, for a window that no longer
 * holds the divider it left through (`agent/handoff-context.ts`, `deltaOrphans`).
 */
export const handoffBeforeDeltaOf = async (context: QueryCtx, args: { dividerMessageId: Id<"messages">; threadId: Id<"threads"> }): Promise<string[]> => {
    const divider = await getThreadRow(context, args.threadId, args.dividerMessageId);
    const part = divider && agentSwitchOf(divider);

    return part ? await deltaBase(context, args.threadId, part, MAX_HANDOFF_DEPTH) : [];
};

export const getHandoffBeforeDelta = internalQuery
    .input({ dividerMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.array(v.string()))
    .query(async ({ args, ctx }) => await handoffBeforeDeltaOf(ctx, args));

/**
 * Re-points the `activeAgent` cache after the active path moved: a sibling switch, a regenerate's
 * prompt, a saved edit. `fromMessageId` is the row the path now ends at — NOT descended to a leaf,
 * because a regenerate runs on its prompt's path and a switch below the prompt is not on it.
 * A thread that was never switched has nothing to keep in step.
 */
export const syncActiveAgent = async (context: MutationCtx, threadId: Id<"threads">, fromMessageId: string): Promise<void> => {
    const thread = await context.db.get(threadId);

    if (!thread?.activeAgent) {
        return;
    }

    const agent = await resolvePathAgent(context, thread, await getThreadRow(context, threadId, fromMessageId));

    if (agent && !sameAgent(agent, thread.activeAgent)) {
        await patchThread(context.db, threadId, { activeAgent: agent });
    }
};

/**
 * Whether `prompt` is the newest turn of the path ending at `leaf`: the only rows below it are its
 * replies and switch dividers, no later prompt. A switch made after that turn hangs under its
 * reply, so it is the thread's current agent a regenerate of the turn is meant to run on.
 */
const isLatestTurn = async (context: Reader, threadId: Id<"threads">, leaf: Row, prompt: Row): Promise<boolean> => {
    let cursor: Row | null = leaf;

    while (cursor && cursor._id !== prompt._id) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PATH_PAGE_ROWS, stopAtId: prompt._id });

        if (rows.some((row) => (row.message as { role?: string } | undefined)?.role === "user")) {
            return false;
        }

        cursor = next;
    }

    return cursor !== null;
};

/**
 * The model a send must run on, or `null` to keep the one it brought: the thread was never
 * switched, or its creation model is unknown. A regenerate names its prompt (`promptMessageId`:
 * the path through it, inclusive) — except for the newest turn of the displayed path, which
 * runs on the displayed leaf's agent, so a pick made after its reply applies to the redo; an edit
 * names the message it replaces (`replacedMessageId`: the path above it); a plain send continues
 * the displayed path.
 */
export const runAgentModelOf = async (
    context: QueryCtx,
    args: { promptMessageId?: Id<"messages">; replacedMessageId?: Id<"messages">; threadId: Id<"threads"> },
): Promise<string | null> => {
    const thread = await context.db.get(args.threadId);

    if (!thread?.activeAgent) {
        return null;
    }

    let from: Row | null;

    if (args.replacedMessageId) {
        const replaced = await getThreadRow(context, args.threadId, args.replacedMessageId);

        from = replaced ? await parentOf(context, args.threadId, replaced) : null;
    } else {
        const leaf = await leafRowOf(context, thread);
        const prompt = args.promptMessageId ? await getThreadRow(context, args.threadId, args.promptMessageId) : null;

        from = args.promptMessageId && !(leaf && prompt && (await isLatestTurn(context, args.threadId, leaf, prompt))) ? prompt : leaf;
    }

    const agent = await resolvePathAgent(context, thread, from);

    return agent?.model ?? null;
};

/**
 * Where a regenerate of `promptId` points the thread, as the row its new reply will hang under.
 *
 * The prompt itself, except for the newest turn of a switched thread whose run picked up the agent of the
 * displayed leaf (`runAgentModelOf`): the prompt's own path does not carry that agent, so a reply hung
 * straight under it would put the thread back on the older one for the next send. A divider under the prompt
 * (an earlier regenerate's, when it names the same switch) is the parent instead, at the end of the prompt's
 * `order` so it sorts before the reply that follows. `runModel` is the model the run actually uses: the
 * divider is written only when it is the one the path ends on.
 */
export const regenerateParentOf = async (
    context: MutationCtx,
    thread: Doc<"threads">,
    promptId: Id<"messages">,
    runModel: string | undefined,
): Promise<string> => {
    if (!thread.activeAgent || runModel === undefined || thread.userId === undefined) {
        return promptId;
    }

    const prompt = await getThreadRow(context, thread._id, promptId);
    const leaf = await leafRowOf(context, thread);

    if (!prompt || !leaf || !(await isLatestTurn(context, thread._id, leaf, prompt))) {
        return promptId;
    }

    const to = await resolvePathAgent(context, thread, leaf);
    const from = await resolvePathAgent(context, thread, prompt);

    if (!to || !from || to.model !== runModel || sameAgent(from, to)) {
        return promptId;
    }

    const siblings = await childrenOf(context, thread._id, prompt);
    const existing = siblings.findLast((row) => {
        const part = agentSwitchOf(row);

        return part !== undefined && sameAgent(part.from, from) && sameAgent(part.to, to);
    });

    if (existing) {
        return existing._id;
    }

    await pinFollowingRowParent(context, thread._id, prompt.order);

    const last = await getMaxMessage(context, thread._id, prompt.order);

    return await insertAgentSwitchRow(context.db, {
        order: prompt.order,
        parentMessageId: prompt._id,
        part: { from, mode: "full", startMessageId: prompt._id, to },
        stepOrder: (last?.stepOrder ?? prompt.stepOrder) + 1,
        threadId: thread._id,
        userId: thread.userId,
    });
};

export const getRunAgentModel = internalQuery
    .input({ promptMessageId: v.optional(v.id("messages")), replacedMessageId: v.optional(v.id("messages")), threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await runAgentModelOf(ctx, args));

/**
 * A fork copies the switch dividers of the path it takes, but not the `activeAgent` cache that makes
 * the fork run on what they say, and a copied divider still names a row of the SOURCE as the one it
 * follows. Points each at the row before it in the fork (the copy is a straight line, so that is its
 * parent) and sets the cache from the newest, and `hasHandoff` when a copied divider carries one; a fork cut
 * before the first switch has neither to fix.
 */
export const adoptForkAgentOf = async (context: MutationCtx, threadId: Id<"threads">): Promise<void> => {
    const thread = await context.db.get(threadId);

    if (!thread || thread.activeAgent) {
        return;
    }

    const switches = await findPathSwitchRows(context, threadId, await leafRowOf(context, thread));

    for (const { part, row } of switches) {
        const parent = await parentOf(context, threadId, row);

        if (parent && parent._id !== part.startMessageId) {
            await patchAgentSwitchRow(context.db, row._id, { ...part, startMessageId: parent._id });
        }
    }

    if (switches[0]) {
        await patchThread(context.db, threadId, {
            activeAgent: switches[0].part.to,
            ...(switches.some(({ part }) => part.handoff) && { hasHandoff: true }),
        });
    }
};

export const adoptForkAgent = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await adoptForkAgentOf(ctx, args.threadId);

        return null;
    });
