/**
 * The pure parts of memory retrieval: which stored rows are candidates, and how a
 * candidate's signals become a score. No I/O and no gateway calls, so the same code
 * runs in `retrieve.ts` and in the offline retrieval eval (`retrieval-eval.test.ts`).
 */

import { bm25Idf, MAX_KEYWORD_TERMS, reciprocalRankFusion, scoreKeywordCandidates } from "../knowledge/hybrid";
import { factDatesOf } from "./dates";
import { salientTermsOf, searchTokensOf } from "./search-terms";
import type { SalientTerm } from "./search-terms";

/**
 * The signals' weights, which add up to 1. Relevance leads: among rows of one topic the cosines are close, so the
 * semantic term must decide (eval NDCG@8: 0.600 at 0.45, 0.771 at 0.65, 0.879 at 0.75). 0.65 is the middle: the
 * eval's confidence and ages are assumed, so the other signals keep a real share.
 */
export const WEIGHTS = {
    confidence: 0.12, // How clearly the fact was stated (0-100)
    importance: 0.08, // How useful for future conversations (0-100)
    recency: 0.15, // Exponential decay with 30-day half-life
    semantic: 0.65, // Vector cosine similarity (or keyword fallback)
};

export const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a memory needs to be injected on its own. Relevance first: under the relevance floor it is left out whatever
 * its confidence, importance or recency, so a recent or pinned row unrelated to the search is not injected. Then a
 * score of `AUTO_INJECT_THRESHOLD`, which only drops a row that is old, unsure and unimportant at once.
 *
 * Tuned on the retrieval eval (`__fixtures__/README.md`): relevant rows start at cosine 0.86 and unrelated ones end
 * at 0.40, so 0.45 leaves a margin over the noise. The keyword floor (on the BM25 share, `keywordSignalsFor`) applies
 * to a memory with no vector, to one whose vector is new or the search did not fill its cut, to one holding the query's
 * rare term, and to every memory when no vector search ran. 0.15 is the highest that keeps every category of the eval
 * (multi Recall@8 0.867 at 0.2, 0.883 at 0.15); the keyword-only run reads Recall@8 0.603 and abstain rate 0.800 there.
 */
export const INJECT_MIN_RELEVANCE = 0.45;
export const INJECT_MIN_KEYWORD_RELEVANCE = 0.15;
export const AUTO_INJECT_THRESHOLD = 0.3;
export const MAX_AUTO_INJECT = 8;

/**
 * What `search_memory` asks of a memory: a low relevance floor, so it is not noise, and no score threshold, so
 * a relevant memory is found however old or unsure it is. Pinned memories need relevance here too.
 */
export const SEARCH_MIN_RELEVANCE = 0.35;
export const SEARCH_MIN_KEYWORD_RELEVANCE = 0.1;
export const SEARCH_THRESHOLD = 0;
/** The most rows `search_memory` returns. */
export const SEARCH_MAX_RESULTS = 10;

/** Rows each scope contributes to the candidate window. */
export const CANDIDATE_WINDOW_SIZE = 100;

/** Vector hits that count per search: the best ones of the chat's own scopes, after the others are dropped. */
export const VECTOR_TOP_K = 30;

/**
 * Hits asked of the index. It holds every bot's rows of the user and has no bot field to filter on, so other bots'
 * (and superseded or expired) hits can fill the top `VECTOR_TOP_K`: it is asked for three times as many and cut
 * to `VECTOR_TOP_K` after the scope check (`topScopedHits`).
 */
export const VECTOR_FETCH_K = VECTOR_TOP_K * 3;

/** What scoring reads of a memory. */
export interface RankCandidate {
    _id: string;
    confidence?: number | null;
    /** Set when the memory has a vector in the index. */
    embeddingId?: string | null;
    eventEnd?: string | null;
    eventStart?: string | null;
    importance?: number | null;
    lastConfirmedAt: number;
    memory: string;
    pinned?: boolean;
    type: string;
    validUntil?: string | null;
}

/** A memory the prompt may receive. */
export interface RankedMemory {
    /** The memory's type (`taxonomy.ts`). Named `category` for the prompt builder and `search_memory`, which predate the taxonomy. */
    category: string;
    confidence: number;
    eventEnd?: string;
    eventStart?: string;
    /** When it was last confirmed or saved: a time, never a day, so a cached copy is dated in the timezone of the run that reads it. */
    lastConfirmedAt: number;
    memory: string;
    /** Recorded on the reply for the "why was this used" view. */
    memoryId: string;
    score: number;
    validUntil?: string;
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

/** Newest first, whatever the type. */
export const byNewest = (a: { _creationTime: number }, b: { _creationTime: number }): number => b._creationTime - a._creationTime;

/** Whose rows a chat reads: the bot's own, plus the user's own when `includeUserWide`. No bot = the user's own only. */
export interface MemoryScope {
    botId?: string;
    includeUserWide?: boolean;
}

/** The scopes a chat reads, as the `botId` each stores (`null` = the user's own rows). */
export const scopesOf = (scope: MemoryScope): (string | null)[] =>
    scope.botId !== undefined && scope.includeUserWide === true ? [scope.botId, null] : [scope.botId ?? null];

/** Whether a row belongs to a scope a chat reads. A hit of another bot's row never does. */
const inScope = (row: { botId?: string | null }, scope: MemoryScope): boolean => scopesOf(scope).includes(row.botId ?? null);

/**
 * The rows of every scope joined into one candidate window. Each scope keeps up to `limit` of its own, so a
 * busy bot cannot push the user's memories out. Merged in `order` (the order each index yields, unless the
 * caller reads by recency).
 */
export const mergeScopeWindows = <T extends { _creationTime: number; type: string }>(
    perScope: T[][],
    limit: number,
    order: (a: T, b: T) => number = byIndexOrder,
): T[] => perScope.flatMap((rows) => rows.slice(0, limit)).toSorted(order);

/**
 * The window the retrieval scores, from every active row of a user: each scope's newest rows, the ones still
 * in effect on `today`, up to `limit` per scope, merged newest first. Newest regardless of type: the index
 * sorts by type first, so reading it as it comes would fill the window with `preference` and `identity` rows
 * and never reach an `activity` one. The database read takes the newest of each type and applies the same
 * `isUsableOn` and `mergeScopeWindows`.
 */
export const selectCandidateWindow = <
    T extends { _creationTime: number; botId?: string | null; pinned?: boolean | null; type: string; validUntil?: string | null },
>(
    activeRows: T[],
    options: MemoryScope & { limit?: number; today?: string },
): T[] => {
    const limit = options.limit ?? CANDIDATE_WINDOW_SIZE;
    const perScope = scopesOf(options).map((scope) =>
        activeRows
            .filter((row) => (row.botId ?? null) === scope)
            .filter((row) => isUsableOn(row, options.today))
            .toSorted(byNewest)
            .slice(0, limit),
    );

    return mergeScopeWindows(perScope, limit, byNewest);
};

/** The best `limit` of the hits (best first) that are rows of a scope the chat reads; the rest are other bots' rows. */
export const topScopedHits = <T extends { botId?: string | null }>(hits: T[], scope: MemoryScope, limit: number = VECTOR_TOP_K): T[] =>
    hits.filter((row) => inScope(row, scope)).slice(0, limit);

/**
 * Whether the in-scope hits fill the cut. Only then is a row missing from them known to be less near than all of
 * them; a short cut means other bots' rows took the slots or the index had no more, and says nothing of a row it lacks.
 */
export const vectorCutIsFull = (scopedHits: ReadonlyArray<unknown>): boolean => scopedHits.length >= VECTOR_TOP_K;

/**
 * Rows one keyword lookup reads of the search index. The index matches the term as a prefix and ranks by occurrences,
 * so `time` also returns `timer`, `timeline`, …: it reads well past the rows it keeps, so those cannot crowd out a whole-
 * token match. A retrieval makes one lookup per salient term, at most `MAX_KEYWORD_TERMS`.
 */
export const KEYWORD_LOOKUP_LIMIT = 50;

/** Whole-token, usable, in-scope rows one lookup keeps. */
export const KEYWORD_HITS_PER_TERM = 20;

/** Keyword hits that count per search: the best by BM25, of the chat's own scopes. */
export const KEYWORD_TOP_K = VECTOR_TOP_K;

/** The terms a retrieval looks up: the first `MAX_KEYWORD_TERMS` salient terms of the whole search text. */
export const keywordLookupTerms = (searchText: string): string[] =>
    salientTermsOf(searchText)
        .slice(0, MAX_KEYWORD_TERMS)
        .map(({ term }) => term);

/** One term's lookup: the rows it keeps, and how many usable rows of the user hold the term. */
export interface KeywordLookup<T> {
    /** The index had fewer rows than `KEYWORD_LOOKUP_LIMIT` for the term, so `corpusRows` is every usable row holding it. */
    complete: boolean;
    /** Usable rows of the user, of any scope, holding the term as a whole token. */
    corpusRows: number;
    hits: T[];
    term: string;
}

/**
 * What one lookup keeps of the rows the index returned for `term`, best first: whole-token matches only, not
 * superseded, in effect on `today`, and of the chat's scopes, cut to `KEYWORD_HITS_PER_TERM` only after those checks.
 */
export const keywordLookupOf = <
    T extends { botId?: string | null; memory: string; pinned?: boolean | null; supersededBy?: string | null; validUntil?: string | null },
>(
    term: string,
    fetched: T[],
    scope: MemoryScope,
    today: string | undefined,
): KeywordLookup<T> => {
    const held = fetched.filter((row) => !row.supersededBy && isUsableOn(row, today) && searchTokensOf(row.memory).includes(term));

    return {
        complete: fetched.length < KEYWORD_LOOKUP_LIMIT,
        corpusRows: held.length,
        hits: held.filter((row) => inScope(row, scope)).slice(0, KEYWORD_HITS_PER_TERM),
        term,
    };
};

/** The best `limit` keyword hits, best first by BM25 over whole tokens of what the lookups kept. */
export const topKeywordHits = <T extends { _id: string; memory: string }>(
    lookups: { hits: T[]; term: string }[],
    corpusSize: number,
    limit: number = KEYWORD_TOP_K,
): T[] => {
    const termHits = lookups.map(({ hits, term }) => {
        return {
            hits: hits.map((row) => {
                return { content: row.memory, id: row._id, row };
            }),
            term,
        };
    });

    return scoreKeywordCandidates(termHits, Math.max(corpusSize, CANDIDATE_WINDOW_SIZE), { tokenize: searchTokensOf, wholeTokens: true })
        .slice(0, limit)
        .map(({ candidate }) => candidate.row);
};

/** The vector hits and the keyword hits as one list, by Reciprocal Rank Fusion of their ranks; a row is in it once. */
export const fuseSearchHits = <T extends { _id: string }>(vectorHits: T[], keywordHits: T[]): T[] =>
    reciprocalRankFusion([vectorHits, keywordHits], (row) => row._id).map(({ item }) => item);

/** How long after it was written or reworded a memory's vector may not be searchable yet (the index syncs after the write). */
export const VECTOR_SYNC_WINDOW_MS = 10 * 60 * 1000;

/**
 * The candidates to score: the window, plus the search hits (vector and keyword, fused) that fall outside it. A hit of
 * another scope (another bot's row) or of a fact past its end date is never added, and a row is a candidate once.
 */
export const withSearchHits = <T extends RankCandidate & { botId?: string | null; validUntil?: string | null }>(
    window: T[],
    hits: T[],
    options: MemoryScope & { today?: string },
): T[] => {
    const seen = new Set(window.map((row) => row._id));
    const added = hits.filter((row) => {
        if (seen.has(row._id) || !inScope(row, options) || !isUsableOn(row, options.today)) {
            return false;
        }

        seen.add(row._id);

        return true;
    });

    return [...window, ...added];
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

/**
 * A term at most this many usable rows of the user hold is rare (its lookup, which reads the whole user, says how
 * many). A row holding the query's rare term counts by its words even where the vector search says otherwise:
 * embeddings miss exact tokens (a code, a name, a rare word), which is what such a term usually is.
 */
export const RARE_TERM_MAX_ROWS = 2;

/**
 * The query's rare term: its leading identifier, or else the rarest looked-up term (the earlier on a tie), when that
 * term's lookup read every row holding it and at most `RARE_TERM_MAX_ROWS` usable rows of the user do.
 */
const rareTermOf = (terms: SalientTerm[], corpus: ReadonlyMap<string, { complete: boolean; corpusRows: number }>): string | undefined => {
    const rareRows = (term: string): number | undefined => {
        const lookup = corpus.get(term);

        return lookup?.complete === true && lookup.corpusRows > 0 && lookup.corpusRows <= RARE_TERM_MAX_ROWS ? lookup.corpusRows : undefined;
    };
    const [leading] = terms;

    if (leading?.code === true) {
        return rareRows(leading.term) === undefined ? undefined : leading.term;
    }

    let rarest: { held: number; term: string } | undefined;

    for (const { term } of terms) {
        const held = rareRows(term);

        if (held !== undefined && (rarest === undefined || held < rarest.held)) {
            rarest = { held, term };
        }
    }

    return rarest?.term;
};

/** What the keyword side knows of each candidate. */
export interface KeywordSignals {
    /** BM25 over the candidates, as a share of the most the query's terms found in the memory could score (0-1). */
    keywordScores: Map<string, number>;
    /** The candidates holding the query's leading term and its rare term. */
    rareTermMatches: Set<string>;
}

/**
 * The keyword signals of every candidate, over every salient term of the search (`salientTermsOf`; the lookups take
 * only the first few) matched as whole tokens, as the index splits them.
 *
 * - The score is BM25 over the candidates, counted as at least a window of rows, divided by the sum of IDF over the
 *   terms the memory holds at all (a candidate holds it, or its lookup found a row): the IDF-weighted share of those
 *   terms a row holds. A word the memory never had does not dilute the one it does, such as an identifier.
 * - When the query's leading term is an identifier no candidate holds (`QZ-5508`), the query asks for something the
 *   memory does not have: no candidate has keyword relevance, whatever common word it shares.
 * - The rare term is that identifier, or else the rarest looked-up term, when its lookup is complete and at most
 *   `RARE_TERM_MAX_ROWS` rows of the user hold it; a word leading term must be in the memory at all. A rare-term match
 *   holds the rare term and the leading term, so a row sharing only one ordinary word with the query is not one.
 */
export const keywordSignalsFor = (
    candidates: RankCandidate[],
    searchText: string,
    lookups: ReadonlyArray<{ complete: boolean; corpusRows: number; term: string }> = [],
): KeywordSignals => {
    const keywordScores = new Map<string, number>();
    const rareTermMatches = new Set<string>();
    const terms = salientTermsOf(searchText);
    const rows = candidates.map((m) => {
        return { content: m.memory, id: m._id, tokens: searchTokensOf(m.memory) };
    });
    const termHits = terms.map(({ term }) => {
        return { hits: rows.filter((row) => row.tokens.includes(term)), term };
    });
    const [leading] = terms;
    const leadingHits = termHits[0]?.hits ?? [];

    if (leading === undefined || (leading.code && leadingHits.length === 0)) {
        return { keywordScores, rareTermMatches };
    }

    const corpus = new Map(lookups.map((lookup) => [lookup.term, lookup]));
    const inMemory = (term: string, held: number): boolean => held > 0 || (corpus.get(term)?.corpusRows ?? 0) > 0;
    const corpusSize = Math.max(candidates.length, CANDIDATE_WINDOW_SIZE);
    const most = termHits.reduce((sum, { hits, term }) => sum + (inMemory(term, hits.length) ? bm25Idf(hits.length, corpusSize) : 0), 0);

    const scored = scoreKeywordCandidates(termHits, corpusSize, { tokenize: searchTokensOf, wholeTokens: true });

    for (const { candidate, score } of scored) {
        keywordScores.set(candidate.id, Math.min(score / most, 1));
    }

    const rareTerm = leading.code || inMemory(leading.term, leadingHits.length) ? rareTermOf(terms, corpus) : undefined;
    const leadingIds = new Set(leadingHits.map((hit) => hit.id));
    const rareHits = termHits.find(({ term }) => term === rareTerm)?.hits ?? [];

    for (const hit of rareHits) {
        if (leadingIds.has(hit.id)) {
            rareTermMatches.add(hit.id);
        }
    }

    return { keywordScores, rareTermMatches };
};

/**
 * Scores each candidate and keeps the ones to inject. Relevance is a vector hit's cosine similarity; a candidate
 * without a hit falls back to its keyword score (`keywordSignalsFor`) and the keyword floor, unless the vector search
 * is decisive (`vectorSearched`: it ran, its hits resolved, and they fill the cut, `vectorCutIsFull`) and the memory has a
 * vector that is not new: then it was not among the nearest to the search, and its keyword overlap (common words of
 * a question) says nothing more, so it has no relevance. Absence is no evidence otherwise: a vector written or
 * reworded within `VECTOR_SYNC_WINDOW_MS` may not be searchable yet, a short cut means other bots' rows took the
 * slots, and a memory with no vector, or any memory when no vector search ran (the model refused, the index or the
 * hit lookup failed), is found by keyword. A candidate holding the query's rare term (`rareTermMatches`) is also
 * found by keyword, whatever the vector search says of it: it takes the better of the two. Under the relevance floor,
 * or under the score threshold, a candidate is left out; the rest is sorted best first and cut to `limit`. `now` is
 * when scoring happens (recency counts from it).
 */
export const rankMemories = (input: {
    candidates: RankCandidate[];
    keywordScores: ReadonlyMap<string, number>;
    limit?: number;
    /** The least keyword overlap a candidate without a vector hit needs. */
    minKeywordRelevance?: number;
    /** The least cosine similarity a vector hit needs before the other terms count. */
    minRelevance?: number;
    now: number;
    /** Candidates holding the query's rare term: found by keyword even when the vector search lacks them or scores them low. */
    rareTermMatches?: ReadonlySet<string>;
    threshold?: number;
    vectorScores: ReadonlyMap<string, number>;
    /** A vector search ran, its hits resolved and filled the cut: an old embedded memory it lacks is not relevant. */
    vectorSearched?: boolean;
}): RankedMemory[] => {
    const {
        candidates,
        keywordScores,
        limit = MAX_AUTO_INJECT,
        minKeywordRelevance = INJECT_MIN_KEYWORD_RELEVANCE,
        minRelevance = INJECT_MIN_RELEVANCE,
        now,
        rareTermMatches = new Set<string>(),
        threshold = AUTO_INJECT_THRESHOLD,
        vectorScores,
        vectorSearched = false,
    } = input;

    return (
        candidates
            .map((m) => {
                const hit = vectorScores.get(m._id);
                // Embedded, not new, and absent from hits that filled the cut: not relevant, whatever words it shares.
                const missed = hit === undefined && vectorSearched && Boolean(m.embeddingId) && now - m.lastConfirmedAt > VECTOR_SYNC_WINDOW_MS;
                const byVector = hit !== undefined && hit >= minRelevance ? hit : undefined;
                const keyword = keywordScores.get(m._id) ?? 0;
                const byKeyword = ((hit === undefined && !missed) || rareTermMatches.has(m._id)) && keyword >= minKeywordRelevance ? keyword : undefined;
                const semanticScore = Math.max(byVector ?? 0, byKeyword ?? 0);

                return {
                    category: m.type,
                    confidence: m.confidence ?? 70,
                    lastConfirmedAt: m.lastConfirmedAt,
                    memory: m.memory,
                    memoryId: m._id,
                    relevant: byVector !== undefined || byKeyword !== undefined,
                    score: computeScore(m, semanticScore, now),
                    ...factDatesOf(m),
                };
            })
            // Confidence, importance and recency only order what is relevant: a fresh, pinned or confident row
            // with no relevance never clears the bar on those terms alone.
            .filter((m) => m.relevant && m.score >= threshold)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ relevant: _relevant, ...ranked }) => ranked)
    );
};
