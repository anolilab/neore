import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { SUB_AGENT_MAX_DEPTH } from "../sub-agents/logic";
import type { BotToolSelection } from "./tool-selectors";
import { mcpServerKey, NO_TOOLS_SELECTION, parseServerSelector } from "./tool-selectors";

/** A bot's selection with the bot's owner: a key the selection names stands for the owner's servers, not a collaborator's. */
export interface RunToolSelection {
    /** The bot's owner; `""` when the bot could not be read (the selection then keeps no tools). */
    ownerId: string;
    /**
     * The keys of the servers the owner saved, read only when an exclusion names a user server (`mcp=`), else empty. A
     * collaborator's run tells by them whether an exclusion went stale on the owner's side, and which of its own servers
     * the owner also has (`selectionServerKey`).
     */
    ownerServerKeys: string[];
    selection: BotToolSelection;
}

/** What a run reads when its bot cannot be told: no tools, owned by no one. */
export const NO_TOOLS_RUN_SELECTION: RunToolSelection = { ownerId: "", ownerServerKeys: [], selection: NO_TOOLS_SELECTION };

/** The keys of the servers a user saved, enabled or not. */
const savedServerKeysOf = async (ctx: QueryCtx, userId: string): Promise<string[]> => {
    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return (preferences?.mcpServers ?? []).flatMap((server) => mcpServerKey(server.url) ?? []);
};

/** A thread has one parent link per way it was made (branch, continuation, sub-agent): a few at most. */
const MAX_THREAD_LINKS = 10;

/** The parent a sub-agent child thread was linked under (`threadRelationships`, `branchType: "subagent"`), if any. */
const subAgentParentOf = async (ctx: QueryCtx, threadId: Id<"threads">): Promise<string | undefined> => {
    const links = await ctx.db
        .query("threadRelationships")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .take(MAX_THREAD_LINKS);

    return links.find((link) => link.branchType === "subagent")?.parentThreadId;
};

/**
 * The tool selection of the bot a run or an app call belongs to: the bot it names, else the bot of its thread, or of a
 * sub-agent chain's lead. Unlike `findRunBot` (`functions.ts`) it does not ask who owns the thread or the bot: a selection only
 * removes tools, so a write collaborator's turn in a bot's chat is narrowed by the owner's selection too. It runs where the
 * thread lives (the owner's shard). Fails closed: a thread that cannot be read, or a chain deeper than a sub-agent can
 * go, gives no tools. `null` = no bot (or a deleted one, which reads as the plain assistant), or a bot that keeps every tool.
 */
export const readRunToolSelection = async (ctx: QueryCtx, { botId, threadId }: { botId?: string; threadId?: string }): Promise<RunToolSelection | null> => {
    let id = botId;
    let next = id === undefined ? threadId : undefined;

    // One thread per nesting level: a chain longer than a sub-agent can go is not one this run can trust.
    for (let step = 0; step <= SUB_AGENT_MAX_DEPTH + 1; step += 1) {
        if (next === undefined) {
            break;
        }

        if (step > SUB_AGENT_MAX_DEPTH) {
            return NO_TOOLS_RUN_SELECTION;
        }

        const normalized = ctx.db.normalizeId("threads", next);
        const thread = normalized ? await ctx.db.get("threads", normalized) : null;

        if (!thread) {
            return NO_TOOLS_RUN_SELECTION;
        }

        id = thread.botId;

        if (id !== undefined) {
            break;
        }

        const childOf: string = next;
        const run = await ctx.db
            .query("subAgentRuns")
            .withIndex("by_childThreadId", (q) => q.eq("childThreadId", childOf))
            .first();

        // A finished run's row is pruned after a while; the child's `subagent` link to its parent stays, so the chain is still followed.
        next = run ? run.parentThreadId : await subAgentParentOf(ctx, thread._id);
    }

    const bot = id === undefined ? null : await ctx.db.get("bots", id as Id<"bots">);

    if (!bot?.toolSelection) {
        return null;
    }

    const namesUserServer = bot.toolSelection.exclude.some((selector) => parseServerSelector(selector)?.server.startsWith("mcp=") === true);

    return {
        ownerId: bot.userId,
        ownerServerKeys: namesUserServer ? await savedServerKeysOf(ctx, bot.userId) : [],
        selection: bot.toolSelection,
    };
};
