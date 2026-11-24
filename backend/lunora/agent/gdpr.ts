/**
 * The agent module's erasure for account deletion (`gdpr/steps/residual-deletion-steps.ts`
 * calls these). Plain functions over the caller's `ctx`, so the deletes stay in
 * the orchestrator's mutation and the writes are the owner's, not the GDPR module's.
 * Batching follows `gdpr/batch.ts`: at most `BATCH` rows per table, `{ hasMore }` back.
 */
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery, type MutationCtx } from "../_generated/server";
import { BATCH, type BatchResult, deleteParentsWithChildren, full } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";
import { patchRow } from "../lib/patch";
import { storedRow, storedRows } from "../lib/stored-row";
import { countedWorkflowFileIds } from "../workflow/images";
import { changeRefcount, ensureChatFileMetadata } from "./files";
import { MAX_LENGTH } from "../lib/validators";
import { eraseProjectRuleFilesForUser, eraseProjectsRuleFiles, markProjectsRuleFilesErasing, RULE_FILE_ROWS_PER_PAGE } from "../projects/gdpr";
import { erasePinsNamingDocuments } from "../chat/gdpr";
import { deleteVectorRow } from "./table-writes";
import type { VectorTableName } from "./vector/tables";

const EMBEDDING_TABLES = [
    "embeddings_128",
    "embeddings_256",
    "embeddings_512",
    "embeddings_768",
    "embeddings_1024",
    "embeddings_1408",
    "embeddings_1536",
] as const;

/** Deletes an embedding row that may already be gone (a retried round, or a dangling id). */
export const eraseEmbeddingRow = async (ctx: MutationCtx, id: string, what: string): Promise<void> => {
    try {
        await deleteVectorRow(ctx.db, id as Id<VectorTableName>);
    } catch (error: unknown) {
        gdprLogger.error(`Failed to delete ${what} ${id}:`, error);
    }
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

        await Promise.all(rows.map((row) => ctx.db.delete(table, row._id)));
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

    await Promise.all(rows.map((row) => ctx.db.delete("streamingMessages", row._id)));

    return { hasMore: full(rows) };
};

/**
 * Attachment grants (`chatFileAccess`); the shared file rows themselves are
 * reference-counted and reaped by the unused-file cron.
 */
export const eraseChatFileAccessForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: rows } = await ctx.db.chatFileAccess.findMany({ limit: BATCH, where: { userId } });

    await Promise.all(rows.map((row) => ctx.db.delete("chatFileAccess", row._id)));

    return { hasMore: full(rows) };
};

/** Chat-file ids one export page reads (`collectGrantedChatFileIdsForExport`, and the walks of a user's threads and messages). */
export const CHAT_FILE_EXPORT_PAGE = 100;

/** A chat file's name and media type are cut to these lengths in the export, so one page of rows has a bounded size. */
export const CHAT_FILE_NAME_MAX = 512;
export const CHAT_FILE_TYPE_MAX = 255;
/** A content hash is a SHA-256 in hex (64 characters); a longer one was not made by an upload, and is cut so a row stays small. */
export const CHAT_FILE_HASH_MAX = 128;

/**
 * Messages read per query when looking for their files. A message row is read whole (there is no index on `fileIds`), and a message can
 * be large, so the page is small: each query stays well inside the export action's read budget.
 */
export const CHAT_FILE_MESSAGE_PAGE = 20;

/** The UTF-8 bytes a row takes as the query reads it: the unit the export's read budget counts in. */
const rowBytes = (row: unknown): number => new TextEncoder().encode(JSON.stringify(row)).byteLength;

/**
 * One page of the ids of the files the user holds a grant for (`chatFileAccess`): their uploads and generated images. The grant is
 * what makes a file theirs; the row itself is shared by content and has no owner. The caller walks it to its end.
 *
 * The links of their chats (`chatFileThreads`) are not read here. A link outlives the message that named the file (a deleted message
 * releases the file's reference, not its link), so a link names files the chat no longer holds. The messages name what is still there
 * (`collectMessageFileIdsForExport`).
 */
export const collectGrantedChatFileIdsForExport = internalQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            ids: v.array(v.string()),
            // The bytes the query read: each grant row, as stored. The export action meters its walk against a budget with this.
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        // Primary, so a grant made moments before the export is in it (a lagging replica could omit it).
        const grants = await ctx.db.chatFileAccess.findMany({
            consistency: "primary",
            cursor: cursor ?? null,
            limit: CHAT_FILE_EXPORT_PAGE,
            where: { userId },
        });

        return {
            cursor: grants.isDone ? null : grants.continueCursor,
            ids: grants.page.map((grant) => grant.fileId),
            readBytes: grants.page.reduce((total, grant) => total + rowBytes(grant), 0),
        };
    });

/** One page of the owner's thread ids, for walking their messages (`collectAllMessageFileIds`). */
export const collectThreadIdsForExport = internalQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            ids: v.array(v.string()),
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db
            .query("threads")
            .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
            .paginate({ cursor: cursor ?? null, numItems: CHAT_FILE_EXPORT_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            ids: page.page.map((thread) => thread._id),
            readBytes: page.page.reduce((total, thread) => total + rowBytes(thread), 0),
        };
    });

/** One page of the file ids named by one thread's messages (`collectAllMessageFileIds` walks each thread's messages). */
export const collectMessageFileIdsForExport = internalQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        threadId: v.id("threads"),
    })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            ids: v.array(v.string()),
            readBytes: v.number(),
        }),
    )
    .query(async ({ args: { cursor, threadId }, ctx }) => {
        const page = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId))
            .paginate({ cursor: cursor ?? null, numItems: CHAT_FILE_MESSAGE_PAGE });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            ids: page.page.flatMap((message) => message.fileIds ?? []),
            readBytes: page.page.reduce((total, message) => total + rowBytes(message), 0),
        };
    });

/**
 * The metadata of the given chat files, read in one query from `chatFileMetadata` (the caller passes at most one chunk of ids). Metadata
 * only, as a vault file's is: the bytes stay out of the export, and the file row, which holds the extracted text, is not read. A file
 * whose metadata is already gone is left out (its row is erased with it).
 */
export const chatFileMetadataForExport = internalQuery
    .input({ fileIds: v.array(v.id("chatFiles")) })
    .output(
        v.object({
            // The bytes the query read: each metadata row, as stored. The export action meters its chunks against a budget with this.
            readBytes: v.number(),
            rows: v.array(
                v.object({
                    createdAt: v.number(),
                    filename: v.optional(v.string()),
                    filenameCut: v.boolean(),
                    hash: v.string(),
                    id: v.string(),
                    mediaType: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: { fileIds }, ctx }) => {
        if (fileIds.length === 0) {
            return { readBytes: 0, rows: [] };
        }

        // Primary, as the grants are: a file uploaded moments before the export must be in it.
        const { page } = await ctx.db.chatFileMetadata.findMany({ consistency: "primary", where: { fileId: { in: fileIds } } });
        const readRows = storedRows(page);
        const readBytes = readRows.reduce((total, row) => total + rowBytes(row), 0);
        // Two stores of the same bytes at once can each write a metadata row, so a file may have two: the export lists it once.
        const seen = new Set<string>();
        const rowsOf = readRows.filter((row) => {
            if (seen.has(row.fileId)) {
                return false;
            }

            seen.add(row.fileId);

            return true;
        });

        return {
            readBytes,
            rows: rowsOf.map((row) => chatFileExportRow(row)),
        };
    });

/** A file's row in the export, with its name, type and hash cut to their limits. */
const chatFileExportRow = (row: { createdAt: number; fileId: string; filename?: string; hash: string; mediaType: string }) => {
    return {
        createdAt: row.createdAt,
        filename: row.filename?.slice(0, CHAT_FILE_NAME_MAX),
        filenameCut: (row.filename?.length ?? 0) > CHAT_FILE_NAME_MAX,
        hash: row.hash.slice(0, CHAT_FILE_HASH_MAX),
        id: row.fileId,
        mediaType: row.mediaType.slice(0, CHAT_FILE_TYPE_MAX),
    };
};

/**
 * The export's view of files that have none: stored before `chatFileMetadata` was written, or whose write did not land. Each file row is
 * read and its metadata written (`ensureChatFileMetadata`), then answered as {@link chatFileMetadataForExport} answers. The export action
 * calls this for the ids that query found nothing for (`agent/export-pages.ts#readChunkMetadata`), so a file is never left out for the
 * want of a row.
 */
export const repairChatFileMetadataForExport = internalMutation
    .input({ fileIds: v.array(v.id("chatFiles")) })
    .output(
        v.object({
            readBytes: v.number(),
            rows: v.array(
                v.object({
                    createdAt: v.number(),
                    filename: v.optional(v.string()),
                    filenameCut: v.boolean(),
                    hash: v.string(),
                    id: v.string(),
                    mediaType: v.string(),
                }),
            ),
        }),
    )
    .mutation(async ({ args: { fileIds }, ctx }) => {
        let readBytes = 0;
        const rows = [];

        for (const fileId of fileIds) {
            const file = storedRow(await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

            if (!file) {
                continue;
            }

            // The whole row is read, as the metadata query's reads are counted: the export meters these against its budget.
            readBytes += rowBytes(file);
            await ensureChatFileMetadata(ctx, file);
            rows.push(
                chatFileExportRow({ createdAt: file._creationTime, fileId: file._id, filename: file.filename, hash: file.hash, mediaType: file.mediaType }),
            );
        }

        return { readBytes, rows };
    });

/** The file-to-chat links of the user's own chats (`chatFileThreads`, keyed by owner). */
export const eraseChatFileThreadsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("chatFileThreads")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.delete("chatFileThreads", row._id)));

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
        ...relationships.map((r) => ctx.db.delete("threadRelationships", r._id)),
        ...temporaryThreads.map((t) => ctx.db.delete("temporaryThreads", t._id)),
        ...threadAccess.map((a) => ctx.db.delete("threadAccess", a._id)),
    ]);
};

/** One thread's follow-up suggestions, context summaries and invites, one batch each. `true` when any batch came back full. */
export const eraseThreadSuggestionsAndInvites = async (ctx: MutationCtx, threadId: Id<"threads">): Promise<boolean> => {
    const [suggestions, summaries, { page: invites }] = await Promise.all([
        ctx.db
            .query("followupSuggestions")
            .withIndex("by_thread", (q) => q.eq("threadId", threadId))
            .take(BATCH),
        ctx.db
            .query("threadContextSummaries")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .take(BATCH),
        ctx.db.threadInvites.findMany({ limit: BATCH, where: { threadId } }),
    ]);

    await Promise.all([
        ...suggestions.map(async (row) => await ctx.db.delete("followupSuggestions", row._id)),
        ...summaries.map(async (row) => await ctx.db.delete("threadContextSummaries", row._id)),
        ...invites.map(async (row) => await ctx.db.delete("threadInvites", row._id)),
    ]);

    return full(suggestions) || full(summaries) || full(invites);
};

/**
 * Every context summary and compaction the user owns, whichever thread holds it. The per-thread erase above runs before
 * the threads are deleted, so a compaction that finished in between left a row behind. This runs after the threads are
 * gone, when a write for them is refused (`finishThreadSummary` needs the thread), so nothing can be stored behind it.
 */
export const eraseThreadSummariesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map(async (row) => await ctx.db.delete("threadContextSummaries", row._id)));

    return { hasMore: full(rows) };
};

/**
 * One page of the user's projects (`.global()`, read through the ORM facade), each with its rule files: marked, then
 * erased once the project rows are gone, as a project delete does, so a save after the erase finds no project and takes
 * its own back. No earlier step erases rule files: one stopped before this would leave live projects without them. A page is a few reads and at most three
 * writes per project, so an account with many projects never runs one transaction into the subrequest limit.
 *
 * Once the last page is gone, the user's rule files are erased by owner too: a round that failed after its project
 * rows went left their rows marked, and its retry no longer finds those projects; a failed project delete left some
 * too. No project of theirs is left then.
 */
export const eraseProjectsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: projects } = await ctx.db.projects.findMany({ consistency: "primary", limit: RULE_FILE_ROWS_PER_PAGE, where: { userId } });
    const projectIds = projects.map((p) => p._id);

    await markProjectsRuleFilesErasing(ctx, projectIds);
    await Promise.all(projectIds.map((projectId) => ctx.db.delete("projects", projectId)));
    await eraseProjectsRuleFiles(ctx, projectIds);

    if (projects.length >= RULE_FILE_ROWS_PER_PAGE) {
        return { hasMore: true };
    }

    return await eraseProjectRuleFilesForUser(ctx, userId);
};

/** A workflow with no nodes: what a project's workflow becomes once its chat files are released. */
const EMPTY_WORKFLOW = { edges: [], nodes: [] };

/** The projects one round releases, so a large account stays inside one mutation. The next round picks up the rest. */
const PROJECTS_RELEASED_PER_ROUND = 20;

/**
 * The chat files the user's projects hold (image nodes and reference media), released while the owner still holds their grants: a file
 * is counted only while the owner holds a grant for it (`workflow/images.ts#countedWorkflowFileIds`), so this runs before
 * `eraseChatFileAccessForUser`. Once it does, nothing is counted and the release is a no-op. A project whose files are released has its
 * workflow emptied in the same write, so a retried round releases nothing twice. The project rows go in `eraseProjectsForUser`.
 */
export const releaseProjectImagesForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    let cursor: string | null = null;
    let released = 0;
    let more = true;

    while (more) {
        const page = (await ctx.db.projects.findMany({ consistency: "primary", cursor, limit: BATCH, where: { userId } })) as {
            continueCursor: string;
            isDone: boolean;
            page: Doc<"projects">[];
        };

        for (const project of page.page) {
            const { previous } = await countedWorkflowFileIds(ctx.db, userId, project.workflowContent, undefined);

            if (previous.length === 0) {
                continue;
            }

            await changeRefcount(ctx, previous, []);
            await patchRow(ctx.db, "projects", project, { workflowContent: EMPTY_WORKFLOW });

            released += 1;

            if (released >= PROJECTS_RELEASED_PER_ROUND) {
                return { hasMore: true };
            }
        }

        more = !page.isDone;
        cursor = page.isDone ? null : page.continueCursor;
    }

    return { hasMore: false };
};

/** Deletes a batch of executions, each after its node rows; `true` when one was left for the next round. */
const eraseExecutionBatch = async (ctx: MutationCtx, executions: { _id: Id<"workflowExecutions"> }[]): Promise<boolean> => {
    let hasMore = false;

    for (const execution of executions) {
        const nodes = await ctx.db
            .query("nodeExecutions")
            .withIndex("by_execution_and_node", (q) => q.eq("executionId", execution._id))
            .take(BATCH);

        await Promise.all(nodes.map((node) => ctx.db.delete("nodeExecutions", node._id)));

        if (full(nodes)) {
            hasMore = true;
            continue;
        }

        await ctx.db.delete("workflowExecutions", execution._id);
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

/** The user's thread passcodes. A passcode row is the hash of a lock on one of their threads: it goes with them. */
export const eraseThreadPasscodesForUser = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const passcodes = await ctx.db
        .query("threadPasscodes")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .collect();

    await Promise.all(passcodes.map((row) => ctx.db.delete("threadPasscodes", row._id)));
};

/** One batch of the user's documents, each after its versions. */
export const eraseDocumentsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const documents = await ctx.db
        .query("documents")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    // A pin names its document, so each document's pins go first (the chat module owns them). A document whose pins are not all gone yet
    // stays for the next round, so no single call deletes an unbounded pin set.
    const drained = await erasePinsNamingDocuments(ctx, documents);
    const ready = documents.filter((documentRow) => drained.has(documentRow._id));

    const hasMore = await deleteParentsWithChildren(
        ready,
        async (documentRow) =>
            await ctx.db
                .query("documentVersions")
                .withIndex("by_documentId_version", (q) => q.eq("documentId", documentRow._id))
                .take(BATCH),
        {
            child: (version) => ctx.db.delete("documentVersions", version._id),
            parent: (documentRow) => ctx.db.delete("documents", documentRow._id),
        },
    );

    return { hasMore: hasMore || ready.length < documents.length };
};
