/**
 * The pure parts of memory retrieval: which stored rows are candidates, and how a
 * candidate's signals become a score. No I/O and no gateway calls, so the same code
 * runs in `retrieve.ts` and in the offline retrieval eval (`retrieval-eval.test.ts`).
 */

import { bm25Idf, bm25TermFactor, MAX_KEYWORD_TERMS, reciprocalRankFusion, scoreKeywordCandidates } from "../knowledge/hybrid";
import { factDatesOf } from "./dates";
import { canonicalOf, salientTermsOf, searchTokensOf, termCount, termIndexOf } from "./search-terms";
import type { SalientTerm } from "./search-terms";
import { windowDays } from "./time-window";
import type { TimeWindow } from "./time-window";

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
 * at 0.40, so 0.45 leaves a margin over the noise. The keyword floor (on the IDF-weighted keyword share,
 * `keywordSignalsFor`) applies to a memory with no vector, to one whose vector is new or the search did not fill its
 * cut, to one holding the query's rare term, and to every memory when no vector search ran. 0.15 is the highest that keeps every category of the eval
 * (multi Recall@8 0.867 at 0.2, 0.883 at 0.15); the keyword-only run reads Recall@8 0.603 and abstain rate 0.667 there.
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
export const keywordLookupTerms = (searchText: string): LookupTerm[] =>
    salientTermsOf(searchText)
        .slice(0, MAX_KEYWORD_TERMS)
        .map(({ code, term, tokens }) => {
            return { code, term, tokens };
        });

/** The most distinct terms the search index takes in one query. */
export const INDEX_MAX_SEARCH_TERMS = 16;

const LETTER_DIGIT_BOUNDARY_RE = /(?<=\p{L})(?=\p{N})|(?<=\p{N})(?=\p{L})/u;

/**
 * What one lookup asks the index for, each search at most `INDEX_MAX_SEARCH_TERMS` distinct tokens (a longer identifier
 * is searched by its first ones; `keywordLookupOf` still checks the whole of it on every row returned). A word is
 * searched as itself. An identifier is searched as written (`qz 5508`), joined (`qz5508`) and split where letters
 * meet digits, so a memory that spells it another way (`QZ5508` for `QZ-5508`) is found too.
 */
export const lookupSearchesOf = ({ code, tokens }: { code: boolean; tokens: ReadonlyArray<string> }): string[] => {
    const capped = (parts: ReadonlyArray<string>): string => [...new Set(parts)].slice(0, INDEX_MAX_SEARCH_TERMS).join(" ");

    if (!code) {
        return [capped(tokens)];
    }

    const joined = canonicalOf(tokens);
    // As written first: the order is the order the searches are made in.
    const searches = [capped(tokens), capped([joined]), capped(joined.split(LETTER_DIGIT_BOUNDARY_RE))];

    return searches.filter((search, index) => searches.indexOf(search) === index);
};

/** A term to look up: the index is asked for its spellings (`lookupSearchesOf`), and a row is kept only when it holds the term whole. */
export interface LookupTerm {
    /** Part of an identifier (`SalientTerm.code`). */
    code: boolean;
    term: string;
    tokens: string[];
}

/** One term's lookup: the rows it keeps, and how many usable rows of the chat's scopes hold the term. */
export interface KeywordLookup<T> {
    code: boolean;
    /** The index had fewer rows than `KEYWORD_LOOKUP_LIMIT` for the term, so `corpusRows` is every row holding it. */
    complete: boolean;
    /** Usable rows of the chat's scopes holding the term whole; another bot's rows never count. */
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
    { code, term, tokens }: LookupTerm,
    fetched: T[],
    scope: MemoryScope,
    today: string | undefined,
    /** Whether every search the lookup made returned fewer rows than it reads. */
    complete: boolean = fetched.length < KEYWORD_LOOKUP_LIMIT,
): KeywordLookup<T> => {
    const held = fetched.filter(
        (row) => !row.supersededBy && isUsableOn(row, today) && inScope(row, scope) && termCount(termIndexOf(row.memory), { code, tokens }) > 0,
    );

    return {
        code,
        complete,
        corpusRows: held.length,
        hits: held.slice(0, KEYWORD_HITS_PER_TERM),
        term,
    };
};

/** Hits of each salient term's lookup kept ahead of the cut, so one term's rows cannot crowd out another's. */
export const KEYWORD_RESERVED_PER_TERM = 3;

/**
 * The best `limit` keyword hits: first every hit of an identifier's lookup, the rarest identifier first (matched
 * whole, so a long row holding `KX-2291` is not cut behind short rows sharing the query's other words, nor a rare
 * code's row behind two common codes'), then the first `KEYWORD_RESERVED_PER_TERM` of each other term's, then the
 * rest best first by BM25 over whole tokens.
 */
export const topKeywordHits = <T extends { _id: string; memory: string }>(
    lookups: KeywordLookup<T>[],
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

    const reserved = [
        // Rarest first, so two common codes cannot fill the slots before the one row of a rare code.
        ...lookups
            .filter(({ code }) => code)
            .toSorted((a, b) => a.corpusRows - b.corpusRows)
            .flatMap(({ hits }) => hits),
        ...lookups.filter(({ code }) => !code).flatMap(({ hits }) => hits.slice(0, KEYWORD_RESERVED_PER_TERM)),
    ];
    // BM25 over what the lookups counted: a term's df is its lookup's in-scope row count (the hits are cut at 20), and N
    // the most rows any of that tells of. The chat's whole active row count is not read here, so N is a lower bound.
    const rows = new Map(lookups.map(({ corpusRows, term }) => [term, corpusRows]));
    const n = Math.max(corpusSize, CANDIDATE_WINDOW_SIZE, ...rows.values());
    const ranked = scoreKeywordCandidates(termHits, n, { documentFrequency: (term) => rows.get(term), tokenize: searchTokensOf, wholeTokens: true }).map(
        ({ candidate }) => candidate.row,
    );
    const kept = new Map<string, T>();

    for (const row of [...reserved, ...ranked]) {
        if (kept.size >= limit) {
            break;
        }

        kept.set(row._id, row);
    }

    return [...kept.values()];
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
 * A term at most this many usable rows of the chat's scopes hold is rare: its lookup counts them (`corpusRows`, another
 * bot's rows never), and only a `complete` lookup, one the index answered with fewer rows than it reads, knows the
 * count is all of them. A row holding the query's rare term counts by its words even where the vector search says
 * otherwise: embeddings miss exact tokens (a code, a name, a rare word), which is what such a term usually is.
 */
export const RARE_TERM_MAX_ROWS = 2;

/**
 * The query's rare terms: every identifier it names that the memory holds rarely, or, naming none, the rarest looked-up
 * word (the earlier on a tie). Rare means the term's lookup read every row holding it and at most `RARE_TERM_MAX_ROWS`
 * usable rows of the chat do. An identifier no row holds is never one.
 */
const rareTermsOf = (terms: SalientTerm[], corpus: ReadonlyMap<string, { complete: boolean; corpusRows: number }>): string[] => {
    const rareRows = (term: string): number | undefined => {
        const lookup = corpus.get(term);

        return lookup?.complete === true && lookup.corpusRows > 0 && lookup.corpusRows <= RARE_TERM_MAX_ROWS ? lookup.corpusRows : undefined;
    };
    const codes = terms.filter(({ code }) => code);

    // A query naming identifiers looks only at them, each one it names ("serials KX-2291 and WTU-38817").
    if (codes.length > 0) {
        return codes.filter(({ term }) => rareRows(term) !== undefined).map(({ term }) => term);
    }

    let rarest: { held: number; term: string } | undefined;

    for (const { term } of terms) {
        const held = rareRows(term);

        if (held !== undefined && (rarest === undefined || held < rarest.held)) {
            rarest = { held, term };
        }
    }

    return rarest === undefined ? [] : [rarest.term];
};

/** Terms a row must share with a query that names an identifier the memory does not hold. */
export const MIN_TERMS_BESIDE_ABSENT_CODE = 2;

/**
 * For a query naming an identifier the memory does not hold, which asks for something else: drops the keyword score of
 * every row that shares only one of its terms. A row holding one of the query's identifiers answers that one and stays.
 */
const dropOneWordMatches = (keywordScores: Map<string, number>, terms: SalientTerm[], termHits: { hits: { id: string }[] }[]): void => {
    const held = new Map<string, number>();

    for (const [index, { hits }] of termHits.entries()) {
        for (const hit of hits) {
            held.set(hit.id, (held.get(hit.id) ?? 0) + (terms[index]!.code ? MIN_TERMS_BESIDE_ABSENT_CODE : 1));
        }
    }

    for (const [id, count] of held) {
        if (count < MIN_TERMS_BESIDE_ABSENT_CODE) {
            keywordScores.delete(id);
        }
    }
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
 * - The score is the IDF-weighted share of the terms the memory holds at all (a candidate holds it, or its lookup found
 *   a row in the chat's scopes) that a row holds, IDF over the candidates counted as at least a window of rows. A word
 *   the memory never had does not dilute the one it does, such as an identifier.
 * - An identifier the memory does not hold (`QZ-5508`, `COVID-19`) counts in the denominator at the IDF of a term no row
 *   holds, the highest: a row that shares only common words with such a query keeps a smaller share, and one sharing
 *   several of them can still clear the floor.
 * - A rare term (`rareTermsOf`) is never an absent identifier. A rare-term match holds one, and, for a word, the
 *   leading term too, so a row sharing only one ordinary word with the query is not one.
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
        return { id: m._id, index: termIndexOf(m.memory) };
    });
    const termHits = terms.map((term) => {
        return { hits: rows.filter((row) => termCount(row.index, term) > 0), term: term.term };
    });
    const [leading] = terms;

    if (leading === undefined) {
        return { keywordScores, rareTermMatches };
    }

    const leadingHits = termHits[0]?.hits ?? [];

    const corpus = new Map(lookups.map((lookup) => [lookup.term, lookup]));
    const inMemory = (term: string, held: number): boolean => held > 0 || (corpus.get(term)?.corpusRows ?? 0) > 0;
    // The same df and N as `topKeywordHits`: a term's lookup counts every in-scope row holding it, which the candidates
    // (the window and the hits) only sample, so a word many memories hold is common here too.
    const corpusSize = Math.max(candidates.length, CANDIDATE_WINDOW_SIZE, ...lookups.map(({ corpusRows }) => corpusRows));
    const idfs = termHits.map(({ hits, term }, index) => {
        if (inMemory(term, hits.length)) {
            return bm25Idf(Math.max(hits.length, corpus.get(term)?.corpusRows ?? 0), corpusSize);
        }

        // An identifier nobody holds still weighs in, at the IDF of a term no row holds; an absent word does not.
        return terms[index]!.code ? bm25Idf(0, corpusSize) : 0;
    });
    const most = idfs.reduce((sum, idf) => sum + idf, 0);
    const matching = new Set(termHits.flatMap(({ hits }) => hits));
    const avgLength = Math.max(1, [...matching].reduce((sum, row) => sum + row.index.tokens.length, 0) / Math.max(1, matching.size));

    // Σ idf·min(1, factor) / Σ idf: BM25's term-frequency and length factor, capped at 1 so a short row cannot score
    // above its share; a row holding a term once at average length keeps the term's whole IDF.
    for (const [index, { hits }] of termHits.entries()) {
        for (const hit of hits) {
            const factor = Math.min(1, bm25TermFactor(termCount(hit.index, terms[index]!), Math.max(1, hit.index.tokens.length), avgLength));

            keywordScores.set(hit.id, (keywordScores.get(hit.id) ?? 0) + (idfs[index]! * factor) / most);
        }
    }

    if (terms.some(({ code, term }, index) => code && !inMemory(term, termHits[index]!.hits.length))) {
        dropOneWordMatches(keywordScores, terms, termHits);
    }

    const rareTerms = new Set(leading.code || inMemory(leading.term, leadingHits.length) ? rareTermsOf(terms, corpus) : []);
    const leadingIds = new Set(leadingHits.map((hit) => hit.id));
    const rareHits = termHits.filter(({ term }) => rareTerms.has(term)).flatMap(({ hits }) => hits);

    for (const hit of rareHits) {
        // An identifier is distinctive on its own; a rare word needs the query's leading word beside it.
        if (leading.code || leadingIds.has(hit.id)) {
            rareTermMatches.add(hit.id);
        }
    }

    return { keywordScores, rareTermMatches };
};

/**
 * A candidate's keyword relevance, or none. A rare-term match is relevant by definition: it passes the floor however
 * many common words the search carries beside its code, then competes on its weighted score like any other row.
 * Another row counts by keyword only where the vector search leaves it to (`counts`), and only from the floor up.
 */
const keywordRelevanceOf = (keyword: number, floor: number, { counts, rare }: { counts: boolean; rare: boolean }): number | undefined => {
    if (rare) {
        return Math.max(keyword, floor);
    }

    return counts && keyword >= floor ? keyword : undefined;
};

/**
 * What the time a question asks about (`time-window.ts`) adds to a memory's score: an event in the window, a fact that
 * holds through it (its end date is in or after the window and not before today, the window reaching today or later), or a fact that ended before the
 * window starts (a pinned one past its date, or one ending before an asked time ahead). Bounded: the most it moves a
 * score is `event`, so it reorders rows of one topic and never outweighs relevance.
 */
export const TIME_WEIGHTS = { ended: -0.1, event: 0.2, holds: 0.05 };

/**
 * The widest window, in days, in which an event's date alone makes it relevant, for a question about the time alone
 * (`TimeWindow.onlyTime`): a day, a week, a month. "What is coming up tomorrow" names no topic, so no vector or word of
 * it finds the appointment; "what is the weather tomorrow" names one, and the events of tomorrow are not its answer. A
 * year is too wide for its date to say the row is what was asked.
 */
export const DATE_RELEVANCE_MAX_DAYS = 31;

/** The time signal of a memory for a window: its weight, and whether its event date falls in it. */
const timeSignalOf = (m: RankCandidate, window: TimeWindow): { inWindow: boolean; signal: number } => {
    if (m.eventStart && m.eventStart <= window.end && (m.eventEnd ?? m.eventStart) >= window.start) {
        return { inWindow: true, signal: TIME_WEIGHTS.event };
    }

    if (!m.validUntil) {
        return { inWindow: false, signal: 0 };
    }

    if (m.validUntil < window.start) {
        return { inWindow: false, signal: TIME_WEIGHTS.ended };
    }

    // Only a fact still in effect today, for a window reaching today or later: a fact's start is unknown, so holding now
    // says nothing of a year before, and a pinned fact past its end date holds nothing now.
    return { inWindow: false, signal: m.validUntil >= window.today && window.end >= window.today ? TIME_WEIGHTS.holds : 0 };
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
 *
 * With a `timeWindow`, each candidate adds its time signal (`timeSignalOf`), and, for a question about the time alone,
 * an event in a window of at most `DATE_RELEVANCE_MAX_DAYS` is relevant by its date. The demotion only reorders: the threshold reads the score without
 * it. The returned score is capped at 1 (the "memories used" view shows it as a share). Without a window nothing changes.
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
    /** The time the search asks about, when it names one. */
    timeWindow?: TimeWindow;
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
        timeWindow,
        vectorScores,
        vectorSearched = false,
    } = input;
    const dateDecides = timeWindow?.onlyTime === true && windowDays(timeWindow) <= DATE_RELEVANCE_MAX_DAYS;

    return (
        candidates
            .map((m) => {
                const hit = vectorScores.get(m._id);
                // Embedded, not new, and absent from hits that filled the cut: not relevant, whatever words it shares.
                const missed = hit === undefined && vectorSearched && Boolean(m.embeddingId) && now - m.lastConfirmedAt > VECTOR_SYNC_WINDOW_MS;
                const byVector = hit !== undefined && hit >= minRelevance ? hit : undefined;
                const keyword = keywordScores.get(m._id) ?? 0;
                const byKeyword = keywordRelevanceOf(keyword, minKeywordRelevance, {
                    counts: hit === undefined && !missed,
                    rare: rareTermMatches.has(m._id),
                });
                const { inWindow, signal } = timeWindow === undefined ? { inWindow: false, signal: 0 } : timeSignalOf(m, timeWindow);
                // An event of a narrow window is relevant by its date, at least as much as a row at the relevance floor.
                const byDate = dateDecides && inWindow ? minRelevance : undefined;
                const score = computeScore(m, Math.max(byVector ?? 0, byKeyword ?? 0, byDate ?? 0), now);

                return {
                    category: m.type,
                    confidence: m.confidence ?? 70,
                    gate: score + Math.max(0, signal),
                    lastConfirmedAt: m.lastConfirmedAt,
                    memory: m.memory,
                    memoryId: m._id,
                    relevant: byVector !== undefined || byKeyword !== undefined || byDate !== undefined,
                    score: score + signal,
                    ...factDatesOf(m),
                };
            })
            // Confidence, importance and recency only order what is relevant: a fresh, pinned or confident row
            // with no relevance never clears the bar on those terms alone.
            .filter((m) => m.relevant && m.gate >= threshold)
            .toSorted((a, b) => b.score - a.score)
            .slice(0, limit)
            // Overwriting `score` keeps its place among the keys.
            .map(({ gate: _gate, relevant: _relevant, ...ranked }) => {
                return { ...ranked, score: Math.min(1, ranked.score) };
            })
    );
};
