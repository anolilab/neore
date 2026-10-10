/**
 * Knowledge Base CRUD Functions
 *
 * Internal queries and mutations for managing knowledge base files,
 * chunks, and thread attachments.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { patchMessage } from "../agent/table-writes";
import { requireOwnedThread, requireThreadPermission } from "../agent/thread-read-access";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { extractKeywordTerms, scoreKeywordCandidates } from "./hybrid";
import { withoutUndefined } from "../lib/patch";
import { admitKnowledgeFiles } from "../lib/rls/scope";
import { vSource } from "../agent/validators";
import { type KnowledgeSource, mergeKnowledgeSources } from "./citations";
import { deleteKnowledgeFile, DELETING_STATUS } from "./file-removal";
import { normalizeRelativePath, requireOwnCollectionId } from "./documents-shared";
import { assertKnowledgeQuota, knowledgeTierOf } from "./quota";
import { MAX_LENGTH } from "../lib/validators";

// ============================================================================
// Internal Queries
// ============================================================================

export const getFile = internalQuery.input({ fileId: v.id("knowledgeFiles") }).query(async ({ args: { fileId }, ctx }) => await ctx.db.get(fileId));

export const getIndexedFileIds = internalQuery.input({ userId: v.string() }).query(async ({ args: { userId }, ctx }) => {
    const files = await ctx.db
        .query("knowledgeFiles")
        .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "indexed"))
        .collect();

    return files.map((f) => f._id as string);
});

export const getFileChunks = internalQuery
    .input({
        fileId: v.id("knowledgeFiles"),
        limit: v.optional(v.number()),
    })
    .query(async ({ args: { fileId, limit }, ctx }) => {
        const chunks = await ctx.db
            .query("knowledgeChunks")
            .withIndex("by_fileId_chunkIndex", (q) => q.eq("fileId", fileId))
            .take(limit ?? 10);

        return chunks.map((c) => {
            return {
                chunkIndex: c.chunkIndex,
                content: c.content,
            };
        });
    });

export const getThreadKnowledgeFileIds = internalQuery.input({ threadId: v.id("threads") }).query(async ({ args: { threadId }, ctx }) => {
    const links = await ctx.db
        .query("threadKnowledge")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect();

    return links.map((l) => l.knowledgeFileId as string);
});

export const getChunksByEmbeddingIds = internalQuery
    .input({
        embeddingIds: v.array(v.string()),
        knowledgeFileIds: v.array(v.string()),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                chunkId: v.string(),
                chunkIndex: v.number(),
                content: v.string(),
                embeddingId: v.string(),
                fileId: v.string(),
                fileName: v.string(),
            }),
        ),
    )
    .query(async ({ args: { embeddingIds, knowledgeFileIds, userId }, ctx }) => {
        const fileIdSet = new Set(knowledgeFileIds);
        const results: {
            chunkId: string;
            chunkIndex: number;
            content: string;
            embeddingId: string;
            fileId: string;
            fileName: string;
        }[] = [];

        for (const embeddingId of embeddingIds) {
            const chunk = await ctx.db
                .query("knowledgeChunks")
                .withIndex("by_embeddingId", (q) => q.eq("embeddingId", embeddingId))
                .first();

            if (!chunk || chunk.userId !== userId) {
                continue;
            }

            if (!fileIdSet.has(chunk.fileId as string)) {
                continue;
            }

            // Get file name
            const file = await ctx.db.get(chunk.fileId);

            if (!file) {
                continue;
            }

            results.push({
                chunkId: chunk._id as string,
                chunkIndex: chunk.chunkIndex,
                content: chunk.content,
                embeddingId: chunk.embeddingId ?? "",
                fileId: chunk.fileId as string,
                fileName: file.name,
            });
        }

        return results;
    });

/** Hits read per keyword term; also the ceiling on a term's observed document frequency. */
const KEYWORD_HITS_PER_TERM = 50;

/**
 * Keyword (BM25) leg of hybrid knowledge retrieval — see `hybrid.ts`.
 *
 * One `search_content` lookup per salient query term, all in this one query so
 * the action pays a single round-trip to the user's shard. Scoring runs over
 * every hit (so document frequency matches the corpus size it is compared to);
 * the file filter applies afterwards.
 */
export const keywordSearchChunks = internalQuery
    .input({
        knowledgeFileIds: v.array(v.string()),
        limit: v.number(),
        query: v.string(),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                chunkId: v.string(),
                chunkIndex: v.number(),
                content: v.string(),
                fileId: v.string(),
                fileName: v.string(),
                score: v.number(),
            }),
        ),
    )
    .query(async ({ args: { knowledgeFileIds, limit, query, userId }, ctx }) => {
        const terms = extractKeywordTerms(query);

        if (terms.length === 0 || knowledgeFileIds.length === 0) {
            return [];
        }

        const termHits = await Promise.all(
            terms.map(async (term) => {
                const chunks = await ctx.db
                    .query("knowledgeChunks")
                    .withSearchIndex("search_content", (q) => q.search("content", term).eq("userId", userId))
                    .take(KEYWORD_HITS_PER_TERM);

                return {
                    hits: chunks.map((chunk) => {
                        return { chunk, content: chunk.content, id: chunk._id as string };
                    }),
                    term,
                };
            }),
        );

        const indexedFiles = await ctx.db
            .query("knowledgeFiles")
            .withIndex("by_userId_status", (q) => q.eq("userId", userId).eq("status", "indexed"))
            .collect();
        const corpusSize = indexedFiles.reduce((sum, file) => sum + (file.chunkCount ?? 0), 0);

        const fileIdSet = new Set(knowledgeFileIds);
        const fileNames = new Map<string, string>(indexedFiles.map((file) => [file._id as string, file.name]));
        const results: { chunkId: string; chunkIndex: number; content: string; fileId: string; fileName: string; score: number }[] = [];

        for (const { candidate, score } of scoreKeywordCandidates(termHits, corpusSize)) {
            if (results.length >= limit) {
                break;
            }

            const fileId = candidate.chunk.fileId as string;

            if (!fileIdSet.has(fileId)) {
                continue;
            }

            let fileName = fileNames.get(fileId);

            if (fileName === undefined) {
                // Explicit fileIds may name a file that is not (or no longer) `indexed`.
                const file = await ctx.db.get(candidate.chunk.fileId);

                if (!file || file.userId !== userId) {
                    continue;
                }

                fileName = file.name;
                fileNames.set(fileId, fileName);
            }

            results.push({ chunkId: candidate.id, chunkIndex: candidate.chunk.chunkIndex, content: candidate.content, fileId, fileName, score });
        }

        return results;
    });

export const getVaultFile = internalQuery.input({ vaultFileId: v.id("files") }).query(async ({ args: { vaultFileId }, ctx }) => {
    const vaultFile = await ctx.db.get(vaultFileId);

    if (!vaultFile) {
        return undefined;
    }

    return {
        _id: vaultFile._id,
        key: vaultFile.key,
        name: vaultFile.name,
    };
});

// ============================================================================
// Internal Mutations
// ============================================================================

export const updateFileStatus = internalMutation
    .input({
        chunkCount: v.optional(v.number()),
        error: v.optional(v.string()),
        fileId: v.id("knowledgeFiles"),
        // A URL source learns its title and size only once fetched.
        name: v.optional(v.string()),
        size: v.optional(v.number()),
        status: v.string(),
        summary: v.optional(v.string()),
    })
    // `false` = not applied: the file is gone or being removed, and an ingest
    // still running for it must not bring it back to life.
    .output(v.boolean())
    .mutation(async ({ args: { chunkCount, error, fileId, name, size, status, summary }, ctx }) => {
        const file = await ctx.db.knowledgeFiles.findFirst({ where: { _id: fileId } });

        if (!file || file.status === DELETING_STATUS) {
            return false;
        }

        const patch: Partial<Doc<"knowledgeFiles">> = {
            status,
            updatedAt: ctx.now,
        };

        if (chunkCount !== undefined) patch.chunkCount = chunkCount;

        if (summary !== undefined) patch.summary = summary;

        if (error !== undefined) patch.error = error;

        if (name !== undefined) patch.name = name;

        if (size !== undefined) patch.size = size;

        await ctx.db.patch(fileId, withoutUndefined(patch));

        return true;
    });

export const saveChunks = internalMutation
    .input({
        chunks: v.array(
            v.object({
                chunkIndex: v.number(),
                content: v.string(),
                embeddingId: v.optional(v.string()),
                tokenCount: v.optional(v.number()),
            }),
        ),
        fileId: v.id("knowledgeFiles"),
        userId: v.string(),
    })
    // `false` = nothing saved: the file was removed while it was being
    // ingested. The caller then deletes the vectors it already wrote.
    .output(v.boolean())
    .mutation(async ({ args: { chunks, fileId, userId }, ctx }) => {
        const file = await ctx.db.knowledgeFiles.findFirst({ where: { _id: fileId } });

        if (!file || file.status === DELETING_STATUS) {
            return false;
        }

        const insertions = chunks.map((chunk) =>
            ctx.db.insert("knowledgeChunks", {
                chunkIndex: chunk.chunkIndex,
                content: chunk.content,
                embeddingId: chunk.embeddingId,
                fileId,
                tokenCount: chunk.tokenCount,
                userId,
            }),
        );

        await Promise.all(insertions);

        return true;
    });

/**
 * Records the passages a reply was grounded in on its first row, as `source`
 * documents ahead of any it already carries (`citations.ts`) — the chat
 * renderer turns them into the citation chips behind the reply's `[n]`.
 */
export const recordKnowledgeSources = internalMutation
    .input({ messageId: v.id("messages"), sources: v.array(vSource) })
    .output(v.null())
    .mutation(async ({ args: { messageId, sources }, ctx }) => {
        const message = await ctx.db.get(messageId);

        if (!message) {
            return null;
        }

        await patchMessage(ctx.db, messageId, {
            sources: mergeKnowledgeSources(message.sources as { id: string }[] | undefined, sources as KnowledgeSource[]),
        });

        return null;
    });

// ============================================================================
// Public cRPC Functions (for frontend)
// ============================================================================

/**
 * List all knowledge files for the current user — not those being removed
 * in the background (`DELETING_STATUS`).
 */
export const listFiles = authQuery.query(async ({ ctx }) => {
    const files = await ctx.db
        .query("knowledgeFiles")
        .withIndex("by_userId_status", (q) => q.eq("userId", ctx.user.userId))
        .collect();

    return files.filter((file) => file.status !== DELETING_STATUS);
});

/**
 * Add a file to the knowledge base and trigger ingestion.
 */
export const addFile = authMutation
    // Each add schedules an ingestion (fetch, parse, embed), and the public API
    // reaches it too. Its own budget, sized above the vault upload limit that
    // already gates the upload each add follows.
    .use(rateLimit("knowledge/add"))
    .input({
        collectionId: v.optional(v.id("knowledgeCollections")),
        mimeType: v.string().max(MAX_LENGTH.short),
        name: v.string().max(MAX_LENGTH.short),
        /** Where the file sat in an uploaded folder (`webkitRelativePath`). */
        relativePath: v.optional(v.string().max(MAX_LENGTH.key)),
        size: v.number(),
        vaultFileId: v.id("files"),
    })
    .mutation(async ({ args: input, ctx }) => {
        // The vault file must be the caller's own. Without this, anyone holding
        // another user's file id could ingest that file into their own knowledge
        // base and read it back through search.
        const vaultFile = await ctx.db.get(input.vaultFileId as Id<"files">);

        if (!vaultFile || vaultFile.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "File not found");
        }

        await requireOwnCollectionId(ctx.db, input.collectionId, ctx.user.userId);
        // The vault row's size, not the client's claim.
        await assertKnowledgeQuota(ctx, ctx.user.userId, knowledgeTierOf(ctx.user), { bytes: Math.max(vaultFile.size, input.size, 0), files: 1 });

        const insertedId = await ctx.db.insert("knowledgeFiles", {
            collectionId: input.collectionId,
            createdAt: ctx.now,
            mimeType: input.mimeType,
            name: input.name,
            relativePath: normalizeRelativePath(input.relativePath),
            size: input.size,
            status: "pending",
            userId: ctx.user.userId,
            vaultFileId: input.vaultFileId as Id<"files">,
        });
        const knowledgeFileId = insertedId;

        // Trigger ingestion pipeline
        await ctx.scheduler.runAfter(0, internal.knowledge.ingest.ingestFile, {
            knowledgeFileId,
            userId: ctx.user.userId,
        });

        ctx.log.event("knowledge.add_file", { collectionAttached: input.collectionId !== undefined, sizeBytes: input.size });

        return knowledgeFileId;
    });

/**
 * Remove a file from the knowledge base and delete its chunks + embeddings.
 */
export const removeFile = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({
        fileId: v.id("knowledgeFiles"),
    })
    .mutation(async ({ args: input, ctx }) => {
        const fileId = input.fileId as Id<"knowledgeFiles">;
        const file = await ctx.db.get(fileId);

        if (!file || file.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Knowledge file not found");
        }

        await deleteKnowledgeFile(ctx, file);

        ctx.log.event("knowledge.remove_file", { removed: true });

        return { success: true };
    });

/**
 * Attach a knowledge file to a thread.
 *
 * Thread knowledge links belong to the thread's OWNER (`requireOwnedThread`):
 * `threadId` is an arg and there is no RLS, so without it anyone could attach
 * to or detach from any thread. Reading the list needs read access
 * (`getThreadKnowledge`).
 */
export const attachToThread = authMutation
    .use(rateLimit("knowledge/add"))
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: input, ctx }) => {
        const threadId = input.threadId as Id<"threads">;
        const knowledgeFileId = input.knowledgeFileId as Id<"knowledgeFiles">;

        await requireOwnedThread(ctx, threadId, ctx.user.userId);

        // Verify ownership
        const file = await ctx.db.get(knowledgeFileId);

        if (!file || file.userId !== ctx.user.userId) {
            throw new LunoraError("NOT_FOUND", "Knowledge file not found");
        }

        // Check if already attached
        const existing = await ctx.db
            .query("threadKnowledge")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect();

        if (existing.some((l) => (l.knowledgeFileId as string) === (knowledgeFileId as string))) {
            return { alreadyAttached: true };
        }

        await ctx.db.insert("threadKnowledge", {
            addedAt: ctx.now,
            knowledgeFileId,
            threadId,
        });

        ctx.log.event("knowledge.attach_to_thread", { attached: true });

        return { success: true };
    });

/**
 * Detach a knowledge file from a thread.
 */
export const detachFromThread = authMutation
    .use(rateLimit("knowledge/remove"))
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
        threadId: v.id("threads"),
    })
    .mutation(async ({ args: input, ctx }) => {
        const threadId = input.threadId as Id<"threads">;
        const knowledgeFileId = input.knowledgeFileId as Id<"knowledgeFiles">;

        await requireOwnedThread(ctx, threadId, ctx.user.userId);

        const links = await ctx.db
            .query("threadKnowledge")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect();

        const link = links.find((l) => (l.knowledgeFileId as string) === (knowledgeFileId as string));

        if (link) {
            await ctx.db.delete(link._id);
        }

        ctx.log.event("knowledge.detach_from_thread", { removed: Boolean(link) });

        return { success: true };
    });

/**
 * Get knowledge files attached to a thread. Anyone who may READ the thread (its
 * owner or a grantee) sees them; everyone else gets NOT_FOUND. Only files the
 * thread's OWNER owns are listed — the links are the owner's, so a stale link
 * to someone else's file never leaks it.
 */
export const getThreadKnowledge = authQuery
    .input({
        threadId: v.id("threads"),
    })
    .query(async ({ args: input, ctx }) => {
        const threadId = input.threadId as Id<"threads">;

        const { thread } = await requireThreadPermission(ctx, threadId, ctx.user.userId, "read");

        const links = await ctx.db
            .query("threadKnowledge")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect();

        // A thread member reads the owner's attached files (filtered to the
        // owner below), which row-level security only shows once admitted.
        admitKnowledgeFiles(
            ctx,
            links.map((link) => link.knowledgeFileId),
        );

        const files = await Promise.all(
            links.map(async (link) => {
                const file = await ctx.db.get(link.knowledgeFileId);

                if (!file || file.userId !== thread.userId) {
                    return null;
                }

                return {
                    ...file,
                    addedAt: link.addedAt,
                };
            }),
        );

        return files.filter(Boolean);
    });
