/**
 * Memory Retrieval Pipeline
 *
 * Fetches relevant user memories before AI response generation.
 * Two searches find candidates beyond the newest rows: the vector index (cosine similarity) and the keyword index
 * (BM25 over one lookup per salient term), fused by rank. Scoring: relevance (cosine, else the IDF-weighted keyword share) +
 * confidence + importance + recency decay.
 *
 * Implemented as an internalAction (not internalQuery) because ctx.vectorSearch()
 * requires an action context.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { searchVectors } from "../agent/vector/index";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { isSearchIndexBuilding } from "../lib/search-index";
import { gatewayFetch } from "../lib/services";
import { getMemoryEmbeddingModel, MEMORY_EMBEDDING_MODEL_NAME } from "./dedup";
import {
    CANDIDATE_WINDOW_SIZE,
    fuseSearchHits,
    keywordLookupTerms,
    keywordSignalsFor,
    rankMemories,
    SEARCH_MAX_RESULTS,
    SEARCH_MIN_KEYWORD_RELEVANCE,
    SEARCH_MIN_RELEVANCE,
    SEARCH_THRESHOLD,
    topKeywordHits,
    topScopedHits,
    VECTOR_FETCH_K,
    vectorCutIsFull,
    withSearchHits,
} from "./retrieve-ranking";
import type { RankedMemory } from "./retrieve-ranking";

// ============================================================================
// Retrieval Types
// ============================================================================

export type RetrievedMemory = RankedMemory;

// ============================================================================
// Main Retrieval Action
// ============================================================================

export const retrieveRelevantMemories = internalAction
    .input({
        /** The bot the chat runs as: its memories join the user's own. Unset = the user's own only. */
        botId: v.optional(v.string()),
        /** Most memories returned for a `search`: up to `SEARCH_MAX_RESULTS`. Unused for injection, which keeps its own cap. */
        limit: v.optional(v.number()),
        // The user's local day when the caller asked: part of the chat-side cache key, not read by the search.
        localDay: v.optional(v.string()),
        /** The `search_memory` tool: a lower relevance floor, no score threshold, and `limit` rows instead of the injection cap. */
        search: v.optional(v.boolean()),
        searchText: v.string(),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                category: v.string(),
                confidence: v.number(),
                eventEnd: v.optional(v.string()),
                eventStart: v.optional(v.string()),
                lastConfirmedAt: v.number(),
                memory: v.string(),
                memoryId: v.string(),
                score: v.number(),
                validUntil: v.optional(v.string()),
            }),
        ),
    )
    .action(async ({ args, ctx }) => {
        // 1. Gate check
        const memoryEnabled = await ctx.runQuery(internal.memory.functions.isMemoryEnabled, {
            userId: args.userId,
        });

        if (!memoryEnabled) {
            return [];
        }

        // 2. Fetch the user's active memories still in effect today
        type ActiveMemory = {
            _id: string;
            botId?: string | null;
            confidence?: number | null;
            createdAt?: number;
            embeddingId?: string;
            eventEnd?: string;
            eventStart?: string;
            importance?: number | null;
            lastConfirmedAt: number;
            memory: string;
            pinned?: boolean;
            type: string;
            validUntil?: string | null;
        };
        const scope = { botId: args.botId, includeUserWide: true };
        const now = Date.now();
        // The keyword leg runs beside the window read and the vector search, and fails alone: without it, the vector hits
        // and the window still count.
        const terms = keywordLookupTerms(args.searchText);
        const keywordLookups =
            terms.length === 0
                ? Promise.resolve([])
                : ctx
                      .runQuery(internal.memory.functions.searchMemoriesByKeyword, { activeOn: now, ...scope, terms, userId: args.userId })
                      .catch((error: unknown) => {
                          // After a deploy that adds `search_memory_text`, Lunora refuses the index until its backfill covers
                          // the existing rows: not ready yet rather than a failure, so the vector hits and the window decide.
                          if (isSearchIndexBuilding(error)) {
                              ctx.log.event("memory.keyword_search", { preparing: true });
                          } else {
                              console.warn("[memory/retrieve] Keyword search failed, continuing without it:", error);
                          }

                          return [];
                      });
        // A fact past its end date in the user's timezone is never injected (`activeOn`). The window is the newest
        // rows, not the first by type: the vector hits below add the ones it leaves out.
        const windowMemories = (await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, {
            activeOn: now,
            ...scope,
            limit: CANDIDATE_WINDOW_SIZE,
            newestFirst: true,
            userId: args.userId,
        })) as ActiveMemory[];

        // 3. Try vector search for semantic similarity. An empty window does not end it: the window is the newest rows
        // only, and the hits add the ones it left out (an old fact behind many newer, expired ones).
        const vectorScoreMap = new Map<string, number>(); // memoryId → cosine score
        let hitMemories: ActiveMemory[] = [];
        // Whether the search answered with a full in-scope cut: then an old embedded memory it lacks is not relevant.
        let vectorSearched = false;

        try {
            const rules = await loadModelFilterRules(ctx, args.userId);
            const { embeddingModelAllowed } = await import("../chat/lib/gateway-embedding-model");

            // Rules that refuse the embedding model leave keyword scoring alone: the gateway would refuse the call.
            if (embeddingModelAllowed(rules)) {
                const embeddingModel = await getMemoryEmbeddingModel(gatewayFetch(ctx), rules);
                const { embedMany } = await import("../agent/client/search");

                const { embeddings } = await embedMany(ctx, {
                    embeddingModel,
                    threadId: undefined,
                    userId: args.userId,
                    values: [args.searchText.slice(0, 2000)],
                });

                const queryVector = embeddings[0];

                if (queryVector && queryVector.length > 0) {
                    const dimension = queryVector.length;

                    validateVectorDimension(dimension);

                    const vectorResults = await searchVectors(ctx, queryVector, {
                        dimension: dimension as VectorDimension,
                        limit: VECTOR_FETCH_K,
                        model: MEMORY_EMBEDDING_MODEL_NAME,
                        searchAllMessagesForUserId: args.userId,
                        table: "memories",
                    });

                    if (vectorResults.length > 0) {
                        // Bulk-lookup memory records for the vector hits
                        const embeddingIds = vectorResults.map((r) => r._id as string);
                        // Every scope of the user comes back (the index holds other bots' rows too, and cannot filter
                        // on them), so more hits than `VECTOR_TOP_K` were asked for and the best in scope are kept.
                        // An expired or superseded fact is already left out.
                        const matched = (await ctx.runQuery(internal.memory.functions.getMemoriesByEmbeddingIds, {
                            activeOn: now,
                            embeddingIds,
                            userId: args.userId,
                        })) as (ActiveMemory & { embeddingId: string })[];
                        const embeddingScores = new Map(vectorResults.map((r) => [r._id as string, r._score]));
                        const scopedHits = topScopedHits(matched, scope);

                        // Only now, with every hit resolved, are the scores and hits taken: a lookup that threw above
                        // leaves them empty and the memories are found by keyword, as with no vector search.
                        for (const mem of scopedHits) {
                            vectorScoreMap.set(mem._id, embeddingScores.get(mem.embeddingId) ?? 0);
                        }

                        hitMemories = scopedHits;
                        vectorSearched = vectorCutIsFull(scopedHits);
                    }
                }
            }
        } catch (error) {
            // Vector search failed — fall back to keyword scoring for all memories
            console.warn("[memory/retrieve] Vector search failed, falling back to keyword scoring:", error);
        }

        // 4. The window plus the hits it lacks, vector and keyword fused by rank, each only in scope (a hit on another
        // bot's row is never added). Both lookups already left out a fact past its end date, so no day is passed here.
        const lookups = await keywordLookups;
        const keywordHits = topKeywordHits(lookups, windowMemories.length);
        const candidates = withSearchHits(windowMemories, fuseSearchHits(hitMemories, keywordHits), scope);

        // 5. Score each memory (vector hit, else keyword) and keep the ones to inject, or for a search the ones to return
        return rankMemories({
            candidates,
            // The whole search text: only the lookups and the embedding are bounded.
            ...keywordSignalsFor(candidates, args.searchText, lookups),
            ...(args.search === true && {
                limit: Math.min(Math.max(Math.trunc(args.limit ?? SEARCH_MAX_RESULTS), 1), SEARCH_MAX_RESULTS),
                minKeywordRelevance: SEARCH_MIN_KEYWORD_RELEVANCE,
                minRelevance: SEARCH_MIN_RELEVANCE,
                threshold: SEARCH_THRESHOLD,
            }),
            now,
            vectorScores: vectorScoreMap,
            vectorSearched,
        });
    });

export default retrieveRelevantMemories;
