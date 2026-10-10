import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ThreadDoc } from "../validators";
import type { ActionCtx as ActionContext, AgentComponent, MutationCtx as MutationContext, QueryCtx as QueryContext } from "./types";

/**
 * Create a thread to store messages with an Agent.
 * @param ctx The context from a mutation or action.
 */
export const createThread = async (
    ctx: MutationContext | ActionContext,
    _component: AgentComponent,
    args?: { summary?: string; title?: string; userId?: string | null },
) => {
    const { _id: threadId } = await ctx.runMutation(internal.agent.threads.createThread, {
        summary: args?.summary,
        title: args?.title,
        userId: args?.userId ?? undefined,
    });

    return threadId;
};

/**
 * Get the metadata for a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param args.threadId The thread to get the metadata for.
 * @returns The metadata for the thread.
 */
export const getThreadMetadata = async (
    ctx: QueryContext | MutationContext | ActionContext,
    // Kept for the call signature; reads go through `internal` now.
    _component: AgentComponent,
    args: { threadId: string },
): Promise<ThreadDoc> => {
    const thread = await ctx.runQuery(internal.agent.threads.getThreadInternal, {
        threadId: args.threadId as Id<"threads">,
    });

    if (!thread) {
        throw new Error("Thread not found");
    }

    return thread;
};

export const updateThreadMetadata = async (
    context: MutationContext | ActionContext,
    _component: AgentComponent,
    args: { patch: Partial<Omit<ThreadDoc, "_creationTime" | "_id">>; threadId: string },
) =>
    context.runMutation(internal.agent.threads.updateThread, {
        patch: args.patch,
        threadId: args.threadId as Id<"threads">,
    });

/**
 * Search for threads by title, paginated.
 * @param ctx The context passed from the query/mutation/action.
 * @returns The threads matching the search, paginated.
 */
export const searchThreadTitles = async (
    ctx: QueryContext | MutationContext | ActionContext,
    component: AgentComponent,
    { limit, query, userId }: { limit?: number; query: string; userId?: string },
): Promise<ThreadDoc[]> =>
    ctx.runQuery(component.agent.threads.searchThreadTitles, {
        limit: limit ?? 10,
        query,
        userId,
    });
