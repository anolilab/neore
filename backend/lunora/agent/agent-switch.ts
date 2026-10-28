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
import { estimateTokensFromCharacters, PROMPT_CACHE_COLD_START_TOKENS } from "@neore/ai/models";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { lastAgentSwitch, sameAgent } from "./agent-switch-logic";
import type { AgentRef } from "./agent-switch-validators";
import { getThreadRow, parentOf, resolveLeafRow, walkPath } from "./branch-rows";
import { getMaxMessage } from "./messages";
import { patchThread } from "./table-writes";

type Row = Doc<"messages">;
type Reader = Pick<QueryCtx, "db">;

/** Rows read per step of a path walk: a switch is usually near the end, so most walks end in the first. */
const PATH_PAGE_ROWS = 100;

/** The row a new prompt would hang off: the displayed leaf, or the last row of a thread that never branched. */
export const leafRowOf = async (context: QueryCtx, thread: Doc<"threads">): Promise<Row | null> =>
    thread.activeLeafMessageId ? await resolveLeafRow(context, thread._id, thread.activeLeafMessageId) : await getMaxMessage(context, thread._id);

/**
 * The agent the path ending at `from` (inclusive) runs on, or `null` when it has no switch and the
 * thread has no creation model. Stops at the first switch met walking up, so an unswitched path
 * costs its whole length — which is why callers check `activeAgent` first.
 */
export const resolvePathAgent = async (context: Reader, thread: Doc<"threads">, from: Row | null): Promise<AgentRef | null> => {
    let cursor = from;

    while (cursor) {
        const { next, rows } = await walkPath(context, thread._id, cursor, { limit: PATH_PAGE_ROWS });
        const found = lastAgentSwitch(rows);

        if (found) {
            return found.to;
        }

        cursor = next;
    }

    return thread.model ? { kind: "model", model: thread.model } : null;
};

/**
 * Whether the path ending at `from` is long enough that a model change re-sends a cold prompt worth
 * warning about (`PROMPT_CACHE_COLD_START_TOKENS`). Counts the stored text of each row with the
 * shared characters-per-token estimate, and stops as soon as the answer is yes.
 */
export const pathExceedsColdStart = async (context: Reader, threadId: Id<"threads">, from: Row | null): Promise<boolean> => {
    let characters = 0;
    let cursor = from;

    while (cursor) {
        const { next, rows } = await walkPath(context, threadId, cursor, { limit: PATH_PAGE_ROWS });

        for (const row of rows) {
            characters += row.text?.length ?? 0;
        }

        if (estimateTokensFromCharacters(characters) > PROMPT_CACHE_COLD_START_TOKENS) {
            return true;
        }

        cursor = next;
    }

    return false;
};

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
