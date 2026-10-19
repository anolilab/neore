/**
 * Knowledge Base Retrieval
 *
 * Hybrid search over user-uploaded knowledge base files: vector similarity
 * (Vectorize, text-embedding-004) and BM25 keyword search (FTS5 `searchIndex`
 * on `knowledgeChunks`), fused with Reciprocal Rank Fusion. See `hybrid.ts`.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { type ActionCtx, internalAction } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { searchVectors } from "../agent/vector/index";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { callOnShard } from "../lib/cross-shard";
import { assertOk, fetchWithDeadline, HttpError } from "../lib/fetch-timeout";
import { gatewayFetch, SERVICE_ORIGIN } from "../lib/services";
import { reciprocalRankFusion } from "./hybrid";
import { MAX_LENGTH } from "../lib/validators";

const EMBEDDING_MODEL_NAME = "text-embedding-004";
const MAX_RESULTS = 5;

/**
 * What fusion hands the reranker: three times what a caller gets back, so the
 * cross-encoder can promote a passage the rank-only fusion left at 8th.
 */
export const RERANK_CANDIDATES = MAX_RESULTS * 3;

interface RankedChunk {
    chunkId: string;
    chunkIndex: number;
    content: string;
    /** The knowledge file the chunk came from — eval runs match expected sources by it. */
    fileId: string;
    fileName: string;
    /** The page the chunk starts on, for PDF and PPTX; absent for other formats and older chunks. */
    pageNumber?: number;
}

/**
 * Vectorize's `topK` ceiling without values or full metadata. Asked for when
 * the search covers only SOME of the owner's files: the index filter is by
 * owner, not by file, so a top-15 over the whole index could hold none of the
 * scoped files' chunks. Filtered back to the scope and cut to the leg's limit
 * afterwards.
 */
const SCOPED_VECTOR_TOP_K = 100;

/**
 * Embeds the query ONCE, under the requester — billed to them, never to the
 * owner of a shared collection — and the vector is reused for every scope
 * searched (this shard and each owner's). `null` when there is no gateway or
 * the embedding fails: the keyword leg still runs.
 */
const embedQuery = async (ctx: ActionCtx, query: string, userId: string): Promise<number[] | null> => {
    try {
        const { createGatewayEmbeddingModel } = await import("../chat/lib/gateway-embedding-model");
        const embeddingModel = createGatewayEmbeddingModel(gatewayFetch(ctx), { userId });

        const { embedMany } = await import("../agent/client/search");
        const { embeddings } = await embedMany(ctx, {
            embeddingModel,
            threadId: undefined,
            userId,
            values: [query.slice(0, 2000)],
        });
        const queryVector = embeddings[0];

        return queryVector && queryVector.length > 0 ? queryVector : null;
    } catch (error) {
        console.warn("[knowledge_retrieve] Query embedding failed, continuing with keyword results only:", error);

        return null;
    }
};

/**
 * Vector leg: search the owner's Vectorize vectors with an already-embedded
 * query, map them back to chunks in the requested files. Returns chunks best-first.
 */
const searchVectorLeg = async (
    ctx: ActionCtx,
    args: { knowledgeFileIds: string[]; limit: number; ownerId: string; queryVector: number[]; scoped: boolean },
): Promise<RankedChunk[]> => {
    const dimension = args.queryVector.length;

    validateVectorDimension(dimension);

    const vectorResults = await searchVectors(ctx, args.queryVector, {
        dimension: dimension as VectorDimension,
        limit: args.scoped ? SCOPED_VECTOR_TOP_K : args.limit,
        model: EMBEDDING_MODEL_NAME,
        searchAllMessagesForUserId: args.ownerId,
        table: "knowledgeChunks",
    });

    if (vectorResults.length === 0) {
        return [];
    }

    const chunks = await ctx.runQuery(internal.knowledge.functions.getChunksByEmbeddingIds, {
        embeddingIds: vectorResults.map((r) => r._id as string),
        knowledgeFileIds: args.knowledgeFileIds,
        userId: args.ownerId,
    });

    const scoreMap = new Map(vectorResults.map((r) => [r._id as string, r._score]));

    return chunks.toSorted((a, b) => (scoreMap.get(b.embeddingId) ?? 0) - (scoreMap.get(a.embeddingId) ?? 0)).slice(0, args.limit);
};

const vHit = v.object({
    chunkId: v.string(),
    chunkIndex: v.number(),
    content: v.string(),
    fileId: v.string(),
    fileName: v.string(),
    pageNumber: v.optional(v.number()),
    score: v.number(),
});

type Hit = { chunkId: string; chunkIndex: number; content: string; fileId: string; fileName: string; pageNumber?: number; score: number };

/**
 * Fuses the two legs by rank (deduplicated by chunk id) into the rows callers
 * read. `score` is the RRF score: comparable within one response, not across.
 * `chunkId` and `chunkIndex` are what a citation points at (`citations.ts`).
 */
export const fuseSearchLegs = (vectorHits: ReadonlyArray<RankedChunk>, keywordHits: ReadonlyArray<RankedChunk>, limit: number = MAX_RESULTS): Hit[] =>
    reciprocalRankFusion<RankedChunk>([vectorHits, keywordHits], (chunk) => chunk.chunkId)
        .slice(0, limit)
        .map(({ item, score }) => {
            return {
                chunkId: item.chunkId,
                chunkIndex: item.chunkIndex,
                content: item.content,
                fileId: item.fileId,
                fileName: item.fileName,
                ...(item.pageNumber !== undefined && { pageNumber: item.pageNumber }),
                score,
            };
        });

/**
 * Merges already-fused result lists — this shard's and each shared
 * collection owner's — by rank again. Scores from different shards are not
 * comparable; ranks are.
 */
export const mergeResultLists = (lists: ReadonlyArray<ReadonlyArray<Hit>>, limit: number = MAX_RESULTS): Hit[] => {
    const nonEmpty = lists.filter((list) => list.length > 0);

    if (nonEmpty.length <= 1) {
        return [...(nonEmpty[0] ?? [])].slice(0, limit);
    }

    return reciprocalRankFusion<Hit>(nonEmpty, (hit) => hit.chunkId)
        .slice(0, limit)
        .map(({ item, score }) => {
            return { ...item, score };
        });
};

/**
 * Both legs over `knowledgeFileIds` on this shard, fused. Either leg may fail
 * alone; with no `queryVector` only the keyword leg runs. `scoped` = the files
 * are a subset of the owner's index (see {@link SCOPED_VECTOR_TOP_K}).
 */
const searchFiles = async (
    ctx: ActionCtx,
    args: { knowledgeFileIds: string[]; ownerId: string; query: string; queryVector: number[] | null; scoped: boolean },
): Promise<Hit[]> => {
    if (args.knowledgeFileIds.length === 0) {
        return [];
    }

    // Run both legs concurrently. Either may fail on its own (index still
    // backfilling) without taking the other down with it.
    const candidateLimit = MAX_RESULTS * 3;
    const { queryVector } = args;
    const [vectorHits, keywordHits] = await Promise.all([
        queryVector
            ? searchVectorLeg(ctx, {
                  knowledgeFileIds: args.knowledgeFileIds,
                  limit: candidateLimit,
                  ownerId: args.ownerId,
                  queryVector,
                  scoped: args.scoped,
              }).catch((error: unknown) => {
                  console.warn("[knowledge_retrieve] Vector search failed, continuing with keyword results only:", error);

                  return [];
              })
            : [],
        ctx
            .runQuery(internal.knowledge.functions.keywordSearchChunks, {
                knowledgeFileIds: args.knowledgeFileIds,
                limit: candidateLimit,
                query: args.query.slice(0, 2000),
                userId: args.ownerId,
            })
            .catch((error: unknown) => {
                console.warn("[knowledge_retrieve] Keyword search failed, continuing with vector results only:", error);

                return [];
            }),
    ]);

    return fuseSearchLegs(vectorHits, keywordHits, RERANK_CANDIDATES);
};

/** How long retrieval waits for the reranker before keeping the fused order: it sits on the path to every knowledge-grounded reply. */
const RERANK_TIMEOUT_MS = 2000;

/** A reranker score for the candidate at `index` of the list that was sent. */
export interface RerankScore {
    index: number;
    score: number;
}

/**
 * Cuts the fused candidates to what callers get. With reranker scores the final
 * order is the fused order and the reranker's order fused AGAIN by rank, not the
 * reranker's order alone: the model is strongest on English and Chinese, and a
 * blend keeps a wrong-language ordering from burying what both legs agreed on.
 * Without scores — nothing to rerank, no reranker bound, any failure — it is the
 * fused order, i.e. what retrieval returned before reranking existed.
 */
export const applyRerank = (candidates: ReadonlyArray<Hit>, scores: ReadonlyArray<RerankScore> | null): Hit[] => {
    // A partial answer would hand its first scored hit the top reranker rank over candidates it never saw.
    if (!scores || new Set(scores.map(({ index }) => index)).size !== candidates.length || candidates.length <= MAX_RESULTS) {
        return candidates.slice(0, MAX_RESULTS);
    }

    const byReranker = scores.toSorted((a, b) => b.score - a.score).flatMap(({ index }) => (candidates[index] ? [candidates[index]] : []));

    return reciprocalRankFusion<Hit>([candidates, byReranker], (hit) => hit.chunkId)
        .slice(0, MAX_RESULTS)
        .map(({ item, score }) => {
            return { ...item, score };
        });
};

/**
 * Asks the gateway's reranker to score the candidates against the query.
 * `null` on every failure: an unbound reranker (503, the normal case in local
 * dev) is silent, anything else logs once and moves on.
 */
const rerankCandidates = async (ctx: ActionCtx, query: string, candidates: ReadonlyArray<Hit>): Promise<RerankScore[] | null> => {
    if (candidates.length <= MAX_RESULTS) {
        return null;
    }

    try {
        const response = await fetchWithDeadline(`${SERVICE_ORIGIN.llmGateway}/internal/rerank`, {
            body: JSON.stringify({ documents: candidates.map((hit) => hit.content), query: query.slice(0, 2000), topN: candidates.length }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            timeoutMs: RERANK_TIMEOUT_MS,
            via: gatewayFetch(ctx),
        });

        await assertOk(response, "Rerank gateway error");

        const { results } = (await response.json()) as { results?: RerankScore[] };

        return Array.isArray(results) ? results : null;
    } catch (error) {
        if (!(error instanceof HttpError && error.status === 503)) {
            console.warn("[knowledge_retrieve] Rerank failed, keeping the fused order:", error);
        }

        return null;
    }
};

/**
 * A member's search over collections someone shared with their organization,
 * run on the OWNER's shard (where the files, chunks and vectors are). Reached
 * only through `callOnShard` from {@link search}; `resolveSharedCollectionFiles`
 * re-checks ownership, sharing and membership here.
 */
export const searchSharedCollections = internalAction
    .input({
        collectionIds: v.array(v.id("knowledgeCollections")),
        ownerId: v.string(),
        query: v.string(),
        /** The query as the REQUESTER embedded it (they pay for it); `null` = keyword leg only. */
        queryVector: v.union(v.array(v.number()), v.null()),
        requesterId: v.string(),
    })
    .output(v.array(vHit))
    .action(async ({ args, ctx }) => {
        const knowledgeFileIds = await ctx.runQuery(internal.knowledge.collections.resolveSharedCollectionFiles, {
            collectionIds: args.collectionIds,
            ownerId: args.ownerId,
            requesterId: args.requesterId,
        });

        return await searchFiles(ctx, { knowledgeFileIds, ownerId: args.ownerId, query: args.query, queryVector: args.queryVector, scoped: true });
    });

/** What {@link search} does, callable with any action context (tested directly). */
export const searchKnowledgeBase = async (
    ctx: ActionCtx,
    args: { admittedRun?: boolean; fileIds?: string[]; query: string; threadId?: string; unlockProof?: string; userId: string },
): Promise<Hit[]> => {
    // 1. Find what to search: explicit files; else what the thread and its
    // project have attached (files and collections); else everything indexed.
    let knowledgeFileIds: string[] | undefined;
    let foreign: { collectionIds: string[]; ownerId: string }[] = [];
    // Explicit files or a thread's attachments are a subset of the index;
    // only the "everything indexed" fallback covers all of it.
    let scoped = true;

    if (args.fileIds && args.fileIds.length > 0) {
        knowledgeFileIds = args.fileIds;
    } else if (args.threadId) {
        // `threadId` is declared `v.union(v.id("threads"), v.string())` because callers
        // also pass raw thread strings, so it has to be re-branded for the query. This
        // runs in an action context, where `ctx.db.asId` is not available.
        const scope = await ctx.runQuery(internal.knowledge.collections.resolveRetrievalScope, {
            ...(args.admittedRun && { admittedRun: true }),
            threadId: args.threadId as Id<"threads">,
            ...(args.unlockProof && { unlockProof: args.unlockProof }),
            userId: args.userId,
        });

        if (scope.hasExplicitScope) {
            knowledgeFileIds = scope.fileIds;
            ({ foreign } = scope);
        }
    }

    if (!knowledgeFileIds) {
        knowledgeFileIds = await ctx.runQuery(internal.knowledge.functions.getIndexedFileIds, { userId: args.userId });
        scoped = false;
    }

    if (knowledgeFileIds.length === 0 && foreign.length === 0) {
        return [];
    }

    // 2. Embed once, as the requester, for every scope below.
    const queryVector = await embedQuery(ctx, args.query, args.userId);

    // 3. This shard's files, and each shared collection on its owner's shard.
    const lists = await Promise.all([
        searchFiles(ctx, { knowledgeFileIds, ownerId: args.userId, query: args.query, queryVector, scoped }),
        ...foreign.map(
            async ({ collectionIds, ownerId }) =>
                (await callOnShard(
                    internal.knowledge.retrieve.searchSharedCollections,
                    {
                        collectionIds: collectionIds as Id<"knowledgeCollections">[],
                        ownerId,
                        query: args.query,
                        queryVector,
                        requesterId: args.userId,
                    },
                    { shardKey: ownerId },
                ).catch((error: unknown) => {
                    console.warn("[knowledge_retrieve] Shared collection search failed:", error);

                    return [];
                })) as Hit[],
        ),
    ]);

    // 4. Fuse by rank, then let the reranker reorder the candidates. `score` is an
    // RRF score either way: comparable within one response, not across.
    const candidates = mergeResultLists(lists, RERANK_CANDIDATES);

    return applyRerank(candidates, await rerankCandidates(ctx, args.query, candidates));
};

export const search = internalAction
    .input({
        /** Set only by a run already admitted under the thread's lock (`streamRunThread`). Internal callers only. */
        admittedRun: v.optional(v.boolean()),
        fileIds: v.optional(v.array(v.string())),
        query: v.string(),
        threadId: v.optional(v.union(v.id("threads"), v.string())),
        unlockProof: v.optional(v.string().max(MAX_LENGTH.short)),
        userId: v.string(),
    })
    .output(v.array(vHit))
    .action(async ({ args, ctx }) => await searchKnowledgeBase(ctx, args));

/** Longest query accepted from a caller; the keyword leg reads only the first 2000 characters anyway. */
const MAX_QUERY_LENGTH = 2000;

/**
 * The caller's own knowledge base, searched the way the `knowledge_search` tool
 * does it. Public so the v1 API (`GET /api/v1/knowledge/search`) can reach it;
 * scoped to `ctx.user.userId`, never a caller-supplied user.
 */
export const searchKnowledge = authAction
    .use(rateLimit("knowledge/search"))
    .input({ query: v.string().max(MAX_LENGTH.long) })
    .output(v.array(v.object({ chunkIndex: v.number(), content: v.string(), fileName: v.string(), pageNumber: v.optional(v.number()), score: v.number() })))
    .action(async ({ args, ctx }) => {
        const query = args.query.trim();

        if (query.length === 0 || query.length > MAX_QUERY_LENGTH) {
            throw new LunoraError("BAD_REQUEST", `Query must be 1-${String(MAX_QUERY_LENGTH)} characters`);
        }

        const hits = await ctx.runAction(internal.knowledge.retrieve.search, { query, userId: ctx.user.userId });

        ctx.log.event("knowledge.search_knowledge", { queryLength: query.length, resultCount: hits.length });

        // `.output()` rejects keys it does not declare, so only the public fields go out.
        return hits.map((hit) => {
            return {
                chunkIndex: hit.chunkIndex,
                content: hit.content,
                fileName: hit.fileName,
                ...(hit.pageNumber !== undefined && { pageNumber: hit.pageNumber }),
                score: hit.score,
            };
        });
    });

export default search;
