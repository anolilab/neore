/**
 * Dedup against stored memories, shared by extraction and import: the facts' embeddings, the
 * closest memory by vector (then by word overlap), and the vectors of the rows a run saved.
 */
import type { ModelFilterRules } from "@neore/ai/models";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { searchVectors } from "../agent/vector/index";
import { validateVectorDimension, type VectorDimension } from "../agent/vector/tables";
import { gatewayFetch, type ServiceFetch } from "../lib/services";

const WHITESPACE_RE = /\s+/;

/** Cosine (vector) or Jaccard (words) score from which a memory is a near-match. */
const NEAR_MATCH_SCORE = 0.85;

/**
 * Model name string stored in the vector table for memory embeddings.
 * Must be consistent between extraction and retrieval.
 *
 * The LLM Gateway routes to Workers AI bge-m3 (1024-dim vectors).
 */
export const MEMORY_EMBEDDING_MODEL_NAME = "bge-m3";

/**
 * Create an embedding model instance via the LLM Gateway.
 *
 * The gateway is mandatory — produces 1024-dimensional vectors
 * (bge-m3) for compatibility with the vector table. `gateway` is
 * the calling action's binding, `gatewayFetch(ctx)`; the gateway refuses the
 * model when the user's `modelFilterRules` exclude it, and callers fall back
 * (Jaccard dedup, keyword retrieval) as on any embedding failure.
 */
export const getMemoryEmbeddingModel = async (gateway: ServiceFetch, modelFilterRules: ModelFilterRules) => {
    const { createGatewayEmbeddingModel } = await import("../chat/lib/gateway-embedding-model");

    return createGatewayEmbeddingModel(gateway, { modelFilterRules });
};

/**
 * One embedding per text, or nulls when the user's rules refuse the model (the gateway would
 * refuse the call) or the call fails: dedup then falls back to word overlap.
 */
export const embedMemoryFacts = async (
    ctx: ActionCtx,
    userId: string,
    rules: ModelFilterRules,
    texts: ReadonlyArray<string>,
    logPrefix: string,
): Promise<(number[] | null)[]> => {
    try {
        const { embeddingModelAllowed } = await import("../chat/lib/gateway-embedding-model");

        if (texts.length > 0 && embeddingModelAllowed(rules)) {
            const { embedMany } = await import("../agent/client/search");
            const { embeddings } = await embedMany(ctx, {
                embeddingModel: await getMemoryEmbeddingModel(gatewayFetch(ctx), rules),
                threadId: undefined,
                userId,
                values: [...texts],
            });

            return embeddings;
        }
    } catch (error) {
        console.warn(`${logPrefix} Fact embedding failed, deduping by text:`, error);
    }

    return texts.map(() => null);
};

/** A stored memory as dedup compares against it. */
export interface DedupMemory {
    _id: string;
    botId?: string | null;
    confidence?: number | null;
    embeddingId?: string;
    memory: string;
    pinned?: boolean;
}

export interface SimilarMemoryResult {
    confidence: number | undefined;
    id: Id<"memories">;
    memory: string;
    /** A pinned memory is never revised: a near-match of one is kept beside it instead. */
    pinned: boolean;
    score: number;
}

/**
 * The stored memory closest to the fact's vector, if it is a near-match. Hits are walked best
 * first. Vectors are shared by the user and their bots, so a row outside the run's scope
 * (`botId`; none is the user's own) or one in `retired` is passed over, not taken as "no
 * match". A hit missing from `existing` (past the run's window) is read by its vector id;
 * `row` is what matched, so the caller can keep it in its working set.
 */
export const findSimilarMemoryByVector = async (
    ctx: ActionCtx,
    options: {
        botId: string | undefined;
        embedding: number[];
        existing: ReadonlyArray<DedupMemory>;
        retired?: ReadonlySet<string>;
        userId: string;
    },
): Promise<(SimilarMemoryResult & { row: DedupMemory }) | null> => {
    const { botId, embedding, existing, retired, userId } = options;

    if (embedding.length === 0) {
        return null;
    }

    validateVectorDimension(embedding.length);

    const results = await searchVectors(ctx, embedding, {
        dimension: embedding.length as VectorDimension,
        // Room past the best few: the user's and their bots' vectors share the search, and a wrong-scope hit is skipped.
        limit: 10,
        model: MEMORY_EMBEDDING_MODEL_NAME,
        searchAllMessagesForUserId: userId,
        table: "memories",
    });
    const hits = results.filter((hit) => hit._score >= NEAR_MATCH_SCORE);
    const missing = hits.map((hit) => hit._id as string).filter((id) => existing.every((memory) => memory.embeddingId !== id));
    const read = missing.length > 0 ? await ctx.runQuery(internal.memory.functions.getMemoriesByEmbeddingIds, { embeddingIds: missing, userId }) : [];

    for (const hit of hits) {
        let row: DedupMemory | undefined = existing.find((memory) => memory.embeddingId === hit._id);

        if (!row) {
            const found = read.find((memory) => memory.embeddingId === hit._id);

            if (!found || (found.botId ?? undefined) !== botId || retired?.has(found._id)) {
                continue;
            }

            row = found;
        }

        return {
            confidence: row.confidence ?? undefined,
            id: row._id as Id<"memories">,
            memory: row.memory,
            pinned: row.pinned === true,
            row,
            score: hit._score,
        };
    }

    return null;
};

/** The word set of a text, lowercased. Memoised per text by a caller that compares many facts to one list. */
export type WordSetCache = Map<string, ReadonlySet<string>>;

const wordSetOf = (text: string, cache?: WordSetCache): ReadonlySet<string> => {
    const cached = cache?.get(text);

    if (cached) {
        return cached;
    }

    const words = new Set(text.toLowerCase().split(WHITESPACE_RE).filter(Boolean));

    cache?.set(text, words);

    return words;
};

/** Jaccard similarity of two word sets. */
const jaccardOf = (wordsA: ReadonlySet<string>, wordsB: ReadonlySet<string>): number => {
    if (wordsA.size === 0 && wordsB.size === 0) {
        return 1;
    }

    if (wordsA.size === 0 || wordsB.size === 0) {
        return 0;
    }

    let intersection = 0;

    for (const word of wordsA) {
        if (wordsB.has(word)) intersection += 1;
    }

    const union = wordsA.size + wordsB.size - intersection;

    return union === 0 ? 0 : intersection / union;
};

/**
 * Find the most similar existing memory using Jaccard similarity on word sets.
 * Fast fallback when no embedding is available. Pass one `cache` across the facts of a save.
 */
export const findSimilarMemoryByJaccard = (newFact: string, existingMemories: ReadonlyArray<DedupMemory>, cache?: WordSetCache): SimilarMemoryResult | null => {
    let bestMatch: SimilarMemoryResult | null = null;
    let bestScore = 0;
    const newWords = wordSetOf(newFact, cache);

    for (const existing of existingMemories) {
        const score = jaccardOf(newWords, wordSetOf(existing.memory, cache));

        if (score > bestScore && score >= NEAR_MATCH_SCORE) {
            bestScore = score;
            bestMatch = {
                confidence: existing.confidence ?? undefined,
                id: existing._id as Id<"memories">,
                memory: existing.memory,
                pinned: existing.pinned === true,
                score,
            };
        }
    }

    return bestMatch;
};

/** A vector a row should be linked to, with the text it was computed from. */
export interface MemoryVectorLink {
    embeddingId: string;
    memoryId: Id<"memories">;
    text: string;
}

/**
 * Links stored vectors to their rows, but only while each row still reads as the text its vector
 * was computed from. A vector whose row was edited meanwhile is deleted, not linked: the edit
 * schedules its own re-embed. Never throws: a row without a vector is still found by keyword search.
 */
export const linkMemoryVectors = async (ctx: ActionCtx, userId: string, links: ReadonlyArray<MemoryVectorLink>, logPrefix: string): Promise<void> => {
    try {
        if (links.length === 0) {
            return;
        }

        const unlinked = await ctx.runMutation(internal.memory.functions.linkMemoryEmbeddings, { links: [...links], userId });

        if (unlinked.length > 0) {
            await ctx.runMutation(internal.agent.vector.deleteBatch, {
                // `memories.embeddingId` is a plain string column: memory vectors are 1024-dim (bge-m3), so the id is re-branded here.
                ids: unlinked as Id<"embeddings_1024">[],
            });
        }
    } catch (error) {
        console.error(`${logPrefix} Embedding link failed:`, error);
    }
};

/**
 * Stores the vectors computed for dedup on the rows a run saved, and links them. Never throws.
 * `text` is what each row was saved with, so a row edited since is not linked to its old vector.
 */
export const saveMemoryVectors = async (
    ctx: ActionCtx,
    userId: string,
    saved: ReadonlyArray<{ memoryId: Id<"memories"> | null; text: string; vector: number[] | null }>,
    logPrefix: string,
): Promise<void> => {
    try {
        const withVector = saved.flatMap(({ memoryId, text, vector }) => (memoryId && vector && vector.length > 0 ? [{ memoryId, text, vector }] : []));

        if (withVector.length === 0) {
            return;
        }

        const dimension = withVector[0]!.vector.length;

        validateVectorDimension(dimension);

        const embeddingIds = await ctx.runMutation(internal.agent.vector.insertBatch, {
            vectorDimension: dimension as VectorDimension,
            // `threadId` / `messageId` are `v.optional(...)`, but the generated reference renders
            // them `T | undefined`, so the key is required even though the value may be undefined.
            vectors: withVector.map(({ vector }) => {
                return { messageId: undefined, model: MEMORY_EMBEDDING_MODEL_NAME, table: "memories", threadId: undefined, userId, vector };
            }),
        });

        const links: MemoryVectorLink[] = [];

        for (const [index, { memoryId, text }] of withVector.entries()) {
            const embeddingId = embeddingIds[index];

            if (embeddingId) {
                links.push({ embeddingId: embeddingId as string, memoryId, text });
            }
        }

        await linkMemoryVectors(ctx, userId, links, logPrefix);
    } catch (error) {
        console.error(`${logPrefix} Embedding save failed:`, error);
    }
};
