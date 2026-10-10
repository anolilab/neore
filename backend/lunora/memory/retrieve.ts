/**
 * Memory Retrieval Pipeline
 *
 * Fetches relevant user memories before AI response generation.
 * Uses hybrid scoring: vector cosine similarity (primary) + keyword fallback +
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
import { gatewayFetch } from "../lib/services";
import { getMemoryEmbeddingModel, MEMORY_EMBEDDING_MODEL_NAME } from "./extract";

const WHITESPACE_RE = /\s+/;
// ============================================================================
// Scoring Weights
// ============================================================================

const WEIGHTS = {
    confidence: 0.18, // How clearly the fact was stated (0-100)
    importance: 0.12, // How useful for future conversations (0-100)
    recency: 0.25, // Exponential decay with 30-day half-life
    semantic: 0.45, // Vector cosine similarity (or keyword fallback)
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Threshold for auto-injecting into system prompt (high-confidence memories only).
// Lower-scoring memories are still discoverable via the search_memory tool.
const AUTO_INJECT_THRESHOLD = 0.4;
const MAX_AUTO_INJECT = 8;

// ============================================================================
// Multi-Signal Scoring
// ============================================================================

/** A pinned memory never ages; anything else ages from when it was last confirmed. */
const recencyScore = (lastConfirmedAt: number, pinned: boolean): number => {
    if (pinned) {
        return 1;
    }

    const ageMs = Date.now() - lastConfirmedAt;

    if (ageMs <= 0) {
        return 1;
    }

    return 2 ** (-ageMs / THIRTY_DAYS_MS);
};

const computeScore = (
    memory: {
        confidence?: number | null;
        importance?: number | null;
        lastConfirmedAt: number;
        pinned?: boolean;
    },
    semanticScore: number,
): number => {
    const confidenceNorm = (memory.confidence ?? 70) / 100;
    const importanceNorm = (memory.importance ?? 50) / 100;
    const recency = recencyScore(memory.lastConfirmedAt, memory.pinned === true);

    return WEIGHTS.semantic * semanticScore + WEIGHTS.confidence * confidenceNorm + WEIGHTS.importance * importanceNorm + WEIGHTS.recency * recency;
};

/**
 * Keyword-based semantic score (fallback when no embedding exists).
 */
const keywordScore = (memoryText: string, searchWords: Set<string>): number => {
    if (searchWords.size === 0) {
        return 0;
    }

    const memoryWords = memoryText.toLowerCase().split(WHITESPACE_RE);
    const matchCount = memoryWords.filter((w) => searchWords.has(w)).length;

    return memoryWords.length > 0 ? Math.min(matchCount / Math.max(searchWords.size, 1), 1) : 0;
};

// ============================================================================
// Retrieval Types
// ============================================================================

export interface RetrievedMemory {
    /** The memory's type (`taxonomy.ts`). Named `category` for the prompt builder and `search_memory`, which predate the taxonomy. */
    category: string;
    confidence: number;
    memory: string;
    /** Recorded on the reply for the "why was this used" view. */
    memoryId: string;
    score: number;
}

// ============================================================================
// Main Retrieval Action
// ============================================================================

export const retrieveRelevantMemories = internalAction
    .input({
        searchText: v.string(),
        userId: v.string(),
    })
    .output(
        v.array(
            v.object({
                category: v.string(),
                confidence: v.number(),
                memory: v.string(),
                memoryId: v.string(),
                score: v.number(),
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

        // 2. Fetch all active memories for the user
        type ActiveMemory = {
            _id: string;
            confidence?: number | null;
            createdAt: number;
            embeddingId?: string;
            importance?: number | null;
            lastConfirmedAt: number;
            memory: string;
            pinned?: boolean;
            type: string;
        };
        const activeMemories = (await ctx.runQuery(internal.memory.functions.getActiveMemoriesForUser, {
            limit: 100,
            userId: args.userId,
        })) as ActiveMemory[];

        if (activeMemories.length === 0) {
            return [];
        }

        // 3. Try vector search for semantic similarity
        const vectorScoreMap = new Map<string, number>(); // memoryId → cosine score

        try {
            const embeddingModel = await getMemoryEmbeddingModel(gatewayFetch(ctx));
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
                    limit: 30,
                    model: MEMORY_EMBEDDING_MODEL_NAME,
                    searchAllMessagesForUserId: args.userId,
                    table: "memories",
                });

                if (vectorResults.length > 0) {
                    // Bulk-lookup memory records for the vector hits
                    const embeddingIds = vectorResults.map((r) => r._id as string);
                    const matched = (await ctx.runQuery(internal.memory.functions.getMemoriesByEmbeddingIds, {
                        embeddingIds,
                        userId: args.userId,
                    })) as { _id: string; embeddingId: string }[];

                    // Build map: memoryId → cosine score
                    const embeddingScores = new Map(vectorResults.map((r) => [r._id as string, r._score]));

                    for (const mem of matched) {
                        const score = embeddingScores.get(mem.embeddingId) ?? 0;

                        vectorScoreMap.set(mem._id, score);
                    }
                }
            }
        } catch (error) {
            // Vector search failed — fall back to keyword scoring for all memories
            console.warn("[memory/retrieve] Vector search failed, falling back to keyword scoring:", error);
        }

        // 4. Build keyword search set as fallback
        const searchWords = new Set(
            args.searchText
                .toLowerCase()
                .split(WHITESPACE_RE)
                .filter((w) => w.length >= 2),
        );

        // 5. Score each memory using hybrid approach
        const scored = activeMemories
            .map((m) => {
                // Vector hit: cosine similarity is the semantic score. No embedding
                // yet: pure keyword fallback — zero means no relevance signal, so the
                // memory is still discoverable via the search_memory tool but will not
                // auto-inject unconditionally.
                const semanticScore = vectorScoreMap.has(m._id) ? vectorScoreMap.get(m._id)! : keywordScore(m.memory, searchWords);

                const finalScore = computeScore(m, semanticScore);

                return {
                    category: m.type,
                    confidence: m.confidence ?? 70,
                    memory: m.memory,
                    memoryId: m._id,
                    score: finalScore,
                };
            })
            .filter((m) => m.score >= AUTO_INJECT_THRESHOLD)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, MAX_AUTO_INJECT);

        return scored;
    });

export default retrieveRelevantMemories;
