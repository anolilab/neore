/**
 * The pure parts of memory retrieval: which stored rows are candidates, and how a
 * candidate's signals become a score. No I/O and no gateway calls, so the same code
 * runs in `retrieve.ts` and in the offline retrieval eval (`retrieval-eval.test.ts`).
 */

const WHITESPACE_RE = /\s+/;

export const WEIGHTS = {
    confidence: 0.18, // How clearly the fact was stated (0-100)
    importance: 0.12, // How useful for future conversations (0-100)
    recency: 0.25, // Exponential decay with 30-day half-life
    semantic: 0.45, // Vector cosine similarity (or keyword fallback)
};

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Threshold for auto-injecting into system prompt (high-confidence memories only).
// Lower-scoring memories are still discoverable via the search_memory tool.
export const AUTO_INJECT_THRESHOLD = 0.4;
export const MAX_AUTO_INJECT = 8;

/** Rows each scope contributes to the candidate window. */
export const CANDIDATE_WINDOW_SIZE = 100;

/** Vector hits read per search (before superseded rows are dropped). */
export const VECTOR_TOP_K = 30;

/** What scoring reads of a memory. */
export interface RankCandidate {
    _id: string;
    confidence?: number | null;
    importance?: number | null;
    lastConfirmedAt: number;
    memory: string;
    pinned?: boolean;
    type: string;
}

/** A memory the prompt may receive. */
export interface RankedMemory {
    /** The memory's type (`taxonomy.ts`). Named `category` for the prompt builder and `search_memory`, which predate the taxonomy. */
    category: string;
    confidence: number;
    memory: string;
    /** Recorded on the reply for the "why was this used" view. */
    memoryId: string;
    score: number;
}

// ============================================================================
// Candidate window
// ============================================================================

/** A pinned fact stays past its end date: pinning is how the user keeps it. */
export const isUsableOn = (memory: { pinned?: boolean | null; validUntil?: string | null }, today: string | undefined): boolean =>
    today === undefined || memory.pinned === true || typeof memory.validUntil !== "string" || memory.validUntil >= today;

/** The order `by_userId_botId_active` reads in, newest first: type descending, then creation time descending. */
export const byIndexOrder = (a: { _creationTime: number; type: string }, b: { _creationTime: number; type: string }): number => {
    if (a.type !== b.type) {
        return a.type < b.type ? 1 : -1;
    }

    return b._creationTime - a._creationTime;
};

/**
 * The rows of every scope joined into one candidate window. Each scope keeps up to `limit` of its own, so a
 * busy bot cannot push the user's memories out. Merged in the order each index yields.
 */
export const mergeScopeWindows = <T extends { _creationTime: number; type: string }>(perScope: T[][], limit: number): T[] =>
    perScope.flatMap((rows) => rows.slice(0, limit)).toSorted(byIndexOrder);

/**
 * The window the retrieval scores, from every active row of a user: each scope's rows in index order, the
 * ones still in effect on `today`, up to `limit` per scope, merged. The database read pages through the same
 * index and applies the same `isUsableOn` and `mergeScopeWindows`.
 */
export const selectCandidateWindow = <
    T extends { _creationTime: number; botId?: string | null; pinned?: boolean | null; type: string; validUntil?: string | null },
>(
    activeRows: T[],
    options: { botId?: string; includeUserWide?: boolean; limit?: number; today?: string },
): T[] => {
    const limit = options.limit ?? CANDIDATE_WINDOW_SIZE;
    const scopes: (string | null)[] = [options.botId ?? null];

    if (options.botId !== undefined && options.includeUserWide === true) {
        scopes.push(null);
    }

    const perScope = scopes.map((scope) =>
        activeRows
            .filter((row) => (row.botId ?? null) === scope)
            .toSorted(byIndexOrder)
            .filter((row) => isUsableOn(row, options.today))
            .slice(0, limit),
    );

    return mergeScopeWindows(perScope, limit);
};

// ============================================================================
// Scoring
// ============================================================================

/** A pinned memory never ages; anything else ages from when it was last confirmed. */
const recencyScore = (lastConfirmedAt: number, pinned: boolean, now: number): number => {
    if (pinned) {
        return 1;
    }

    const ageMs = now - lastConfirmedAt;

    if (ageMs <= 0) {
        return 1;
    }

    return 2 ** (-ageMs / THIRTY_DAYS_MS);
};

const computeScore = (memory: RankCandidate, semanticScore: number, now: number): number => {
    const confidenceNorm = (memory.confidence ?? 70) / 100;
    const importanceNorm = (memory.importance ?? 50) / 100;
    const recency = recencyScore(memory.lastConfirmedAt, memory.pinned === true, now);

    return WEIGHTS.semantic * semanticScore + WEIGHTS.confidence * confidenceNorm + WEIGHTS.importance * importanceNorm + WEIGHTS.recency * recency;
};

/** The words of a search text that count for the keyword fallback. */
export const searchWordsOf = (searchText: string): Set<string> =>
    new Set(
        searchText
            .toLowerCase()
            .split(WHITESPACE_RE)
            .filter((w) => w.length >= 2),
    );

/**
 * Keyword-based semantic score (fallback when no embedding exists).
 */
export const keywordScore = (memoryText: string, searchWords: Set<string>): number => {
    if (searchWords.size === 0) {
        return 0;
    }

    const memoryWords = memoryText.toLowerCase().split(WHITESPACE_RE);
    const matchCount = memoryWords.filter((w) => searchWords.has(w)).length;

    return memoryWords.length > 0 ? Math.min(matchCount / Math.max(searchWords.size, 1), 1) : 0;
};

/** The keyword score of every candidate, by id. */
export const keywordScoresFor = (candidates: RankCandidate[], searchText: string): Map<string, number> => {
    const searchWords = searchWordsOf(searchText);

    return new Map(candidates.map((m) => [m._id, keywordScore(m.memory, searchWords)]));
};

/**
 * Scores each candidate and keeps the ones to inject: a vector hit's cosine similarity is its semantic score,
 * a candidate without one falls back to its keyword score. Anything under the threshold is left out, the rest
 * is sorted best first and cut to `limit`. `now` is when scoring happens (recency counts from it).
 */
export const rankMemories = (input: {
    candidates: RankCandidate[];
    keywordScores: ReadonlyMap<string, number>;
    limit?: number;
    now: number;
    threshold?: number;
    vectorScores: ReadonlyMap<string, number>;
}): RankedMemory[] => {
    const { candidates, keywordScores, limit = MAX_AUTO_INJECT, now, threshold = AUTO_INJECT_THRESHOLD, vectorScores } = input;

    return candidates
        .map((m) => {
            // Vector hit: cosine similarity is the semantic score. No embedding
            // yet: pure keyword fallback — zero means no relevance signal, so the
            // memory is still discoverable via the search_memory tool but will not
            // auto-inject unconditionally.
            const semanticScore = vectorScores.has(m._id) ? vectorScores.get(m._id)! : (keywordScores.get(m._id) ?? 0);

            return {
                category: m.type,
                confidence: m.confidence ?? 70,
                memory: m.memory,
                memoryId: m._id,
                score: computeScore(m, semanticScore, now),
            };
        })
        .filter((m) => m.score >= threshold)
        .toSorted((a, b) => b.score - a.score)
        .slice(0, limit);
};
