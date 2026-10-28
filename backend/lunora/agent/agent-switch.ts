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
import { getThreadRow, parentOf, resolveLeafRow, walkPath } from "./branch-rows";
import { findPathHandoff, pathTokens } from "./handoff-source";
import { getMaxMessage } from "./messages";
import { patchAgentSwitchRow, patchThread } from "./table-writes";

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

/**
 * Whether the path ending at `from` is long enough that a model change re-sends a cold prompt worth
 * warning about (`PROMPT_CACHE_COLD_START_TOKENS`). Counts the stored text of each row with the
 * shared characters-per-token estimate, and stops as soon as the answer is yes.
 */
export const pathExceedsColdStart = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<boolean> =>
    (await pathTokens(context, threadId, from, { cap: PROMPT_CACHE_COLD_START_TOKENS })) > PROMPT_CACHE_COLD_START_TOKENS;

/**
 * The stored handoff a context window needs when it starts below the divider that holds it: the newest one
 * on the path above `belowMessageId`. `null` for a thread that was never switched, which is every thread
 * but the few that were and costs them one thread read.
 */
export const handoffAboveOf = async (context: QueryCtx, args: { belowMessageId: Id<"messages">; threadId: Id<"threads"> }): Promise<string | null> => {
    const thread = await context.db.get(args.threadId);

    if (!thread?.activeAgent) {
        return null;
    }

    const below = await getThreadRow(context, args.threadId, args.belowMessageId);
    const from = below && (await parentOf(context, args.threadId, below));

    return (await findPathHandoff(context, args.threadId, from)) ?? null;
};

export const getHandoffAbove = internalQuery
    .input({ belowMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await handoffAboveOf(ctx, args));

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
 * The model a send must run on, or `null` to keep the one it brought: the thread was never
 * switched, or its creation model is unknown. A regenerate names its prompt (`promptMessageId`:
 * the path through it, inclusive), an edit the message it replaces (`replacedMessageId`: the path
 * above it); a plain send continues the displayed path.
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
        from = args.promptMessageId ? await getThreadRow(context, args.threadId, args.promptMessageId) : await leafRowOf(context, thread);
    }

    const agent = await resolvePathAgent(context, thread, from);

    return agent?.model ?? null;
};

export const getRunAgentModel = internalQuery
    .input({ promptMessageId: v.optional(v.id("messages")), replacedMessageId: v.optional(v.id("messages")), threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => await runAgentModelOf(ctx, args));

/**
 * A fork copies the switch dividers of the path it takes, but not the `activeAgent` cache that makes
 * the fork run on what they say, and a copied divider still names a row of the SOURCE as the one it
 * follows. Points each at the row before it in the fork (the copy is a straight line, so that is its
 * parent) and sets the cache from the newest; a fork cut before the first switch has neither to fix.
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
        await patchThread(context.db, threadId, { activeAgent: switches[0].part.to });
    }
};

export const adoptForkAgent = internalMutation
    .input({ threadId: v.id("threads") })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await adoptForkAgentOf(ctx, args.threadId);

        return null;
    });
