/**
 * The agent module's erasure for account deletion (`gdpr/steps/residual-deletion-steps.ts`
 * calls these). Plain functions over the caller's `ctx`, so the deletes stay in
 * the orchestrator's mutation and the writes are the owner's, not the GDPR module's.
 * Batching follows `gdpr/batch.ts`: at most `BATCH` rows per table, `{ hasMore }` back.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, full } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";
import type { VectorTableName } from "./vector/tables";

const EMBEDDING_TABLES = [
    "embeddings_128",
    "embeddings_256",
    "embeddings_512",
    "embeddings_768",
    "embeddings_1024",
    "embeddings_1408",
    "embeddings_1536",
    "embeddings_2048",
    "embeddings_3072",
    "embeddings_4096",
] as const;

/** Deletes an embedding row that may already be gone (a retried round, or a dangling id). */
export const eraseEmbeddingRow = async (ctx: MutationCtx, id: string, what: string): Promise<void> => {
    await ctx.db.delete(id as Id<VectorTableName>).catch((error: unknown) => {
        gdprLogger.error(`Failed to delete ${what} ${id}:`, error);
    });
};

/**
 * Every `embeddings_*` row owned by the user — memories, messages and knowledge
 * alike. None of the ten tables has a `userId` index, so this is a filtered scan;
 * acceptable for a rare, background deletion.
 */
export const eraseEmbeddingsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    let hasMore = false;

    for (const table of EMBEDDING_TABLES) {
        const rows = await ctx.db
            .query(table)
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH);

        await Promise.all(rows.map((row) => ctx.db.delete(row._id)));
        hasMore ||= full(rows);
    }

    return { hasMore };
};

/** Streaming-message rows outlive their thread when a stream is abandoned. No `userId` index. */
export const eraseStreamingMessagesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("streamingMessages")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(rows) };
};

/**
 * Attachment grants (`chatFileAccess`); the shared file rows themselves are
 * reference-counted and reaped by the unused-file cron.
 */
export const eraseChatFileAccessForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: rows } = await ctx.db.chatFileAccess.findMany({ limit: BATCH, where: { userId } });

    await Promise.all(rows.map((row) => ctx.db.delete(row._id)));

    return { hasMore: full(rows) };
};

/** The user's relationship rows, temporary threads and thread grants (held by them, or given on their threads). */
export const eraseThreadMetadataForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const [relationships, temporaryThreads, threadAccess] = await Promise.all([
        ctx.db
            .query("threadRelationships")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect(),
        ctx.db
            .query("temporaryThreads")
            .withIndex("by_userId_expiresAt", (q) => q.eq("userId", userId))
            .collect(),
        // `.global()`: the grants this user HOLDS and the grants others hold on
        // this user's threads — the second set is orphaned once the threads go.
        Promise.all([ctx.db.threadAccess.findMany({ where: { userId } }), ctx.db.threadAccess.findMany({ where: { ownerId: userId } })]).then(
            ([held, given]) => [...held.page, ...given.page.filter((grant) => grant.userId !== userId)],
        ),
    ]);

    await Promise.all([
        ...relationships.map((r) => ctx.db.delete(r._id)),
        ...temporaryThreads.map((t) => ctx.db.delete(t._id)),
        ...threadAccess.map((a) => ctx.db.delete(a._id)),
    ]);
};

/** One thread's follow-up suggestions and invites, one batch each. `true` when either batch came back full. */
export const eraseThreadSuggestionsAndInvites = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const [suggestions, { page: invites }] = await Promise.all([
        ctx.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .take(BATCH),
        ctx.db.threadInvites.findMany({ limit: BATCH, where: { threadId } }),
    ]);

    await Promise.all([...suggestions, ...invites].map(async (row) => await ctx.db.delete(row._id)));

    return full(suggestions) || full(invites);
};

/** The user's projects (`.global()`, read through the ORM facade). */
export const eraseProjectsForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const { page: projects } = await ctx.db.projects.findMany({ where: { userId } });

    await Promise.all(projects.map((p) => ctx.db.delete(p._id)));
};

/** Deletes a batch of executions, each after its node rows; `true` when one was left for the next round. */
const eraseExecutionBatch = async (ctx: MutationCtx, executions: { _id: Id<"workflowExecutions"> }[]): Promise<boolean> => {
    let hasMore = false;

    for (const execution of executions) {
        const nodes = await ctx.db
            .query("nodeExecutions")
            .withIndex("by_execution_and_node", (q) => q.eq("executionId", execution._id))
            .take(BATCH);

        await Promise.all(nodes.map((node) => ctx.db.delete(node._id)));

        if (full(nodes)) {
            hasMore = true;
            continue;
        }

        await ctx.db.delete(execution._id);
    }

    return hasMore;
};

/** Workflow executions the user started, anywhere. */
export const eraseWorkflowExecutionsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const executions = await ctx.db
        .query("workflowExecutions")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .take(BATCH);

    const hasMore = await eraseExecutionBatch(ctx, executions);

    return { hasMore: hasMore || full(executions) };
};

/** Workflow executions of one project (including other people's runs in it). */
export const eraseWorkflowExecutionsForProject = async (ctx: MutationCtx, projectId: Id<"projects">): Promise<BatchResult> => {
    const executions = await ctx.db
        .query("workflowExecutions")
        .withIndex("by_project_and_status", (q) => q.eq("projectId", projectId))
        .take(BATCH);

    const hasMore = await eraseExecutionBatch(ctx, executions);

    return { hasMore: hasMore || full(executions) };
};
