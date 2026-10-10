/**
 * Hybrid (keyword + vector) ranking helpers for knowledge retrieval.
 *
 * Pure functions only — no ctx, no I/O — so they can be unit-tested directly.
 *
 * Why keyword retrieval at all: embeddings are good at paraphrase and poor at
 * exact tokens. A query like `E4012` or `ACME-7731` embeds to roughly "some
 * code", so the one chunk that literally contains it can rank below chunks that
 * merely talk about error codes. BM25 is the opposite. Reciprocal Rank Fusion
 * combines both lists by rank alone, which sidesteps the fact that cosine
 * similarity and BM25 scores live on unrelated scales.
 *
 * The keyword side is backed by Lunora's `searchIndex` on `knowledgeChunks`,
 * which compiles to an SQLite FTS5 table in the user's shard. That index ANDs
 * every query term together (and prefix-matches the last one) and scores by raw
 * term frequency, so a natural-language question would match nothing. We
 * therefore issue one single-term search per salient query term and re-rank the
 * union here with BM25 (`scoreKeywordCandidates`).
 */

/** Standard RRF constant (Cormack et al., 2009). Larger k flattens rank differences. */
export const RRF_K = 60;

/** Upper bound on per-term index searches, so one retrieval costs at most this many FTS5 lookups. */
export const MAX_KEYWORD_TERMS = 6;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const DIGIT_RE = /\p{N}/u;
const COMBINING_MARKS_RE = /[\u{300}-\u{36F}]/gu;

/**
 * Lowercases, strips diacritics and splits on anything that is not a letter or
 * number — the same token boundaries Lunora's search tokenizer uses, so a term
 * we extract is a term the index can hold.
 */
export const tokenize = (text: string): string[] => {
    const normalized = text.normalize("NFD").replaceAll(COMBINING_MARKS_RE, "").normalize("NFC").toLowerCase();

    return normalized.match(TOKEN_RE) ?? [];
};

/**
 * English + German function words. The FTS5 index itself keeps stopwords (the
 * table uses Lunora's `none` language profile), so dropping them is purely about
 * not spending one of the {@link MAX_KEYWORD_TERMS} lookups on "the".
 */
const STOPWORDS = new Set<string>(
    (
        "a an and are as at be but by can could do does did for from has have how if in into is it its me my no not of on or our so " +
        "such than that the their then there these they this to was we were what when where which who why will with would you your " +
        "about any all also just please tell show find give explain " +
        "aber als am an auch auf aus bei bin bis bist da dass der den des dem die das denn dir du ein eine einen einem einer " +
        "für hat ich im in ist mit nicht noch nur oder sich sie sind über und von vor war wie wir zu zum zur was wer wo warum welche"
    )
        .split(" ")
        // Through the tokenizer, so "für" is stored as the "fur" a query produces.
        .flatMap((word) => tokenize(word)),
);

/**
 * Picks the query terms worth a keyword lookup, most distinctive first.
 *
 * Terms containing a digit (IDs, versions, error codes) are the ones vector
 * search is worst at, so they lead; then longer terms before shorter ones.
 * Single characters are dropped unless numeric.
 */
export const extractKeywordTerms = (query: string, maxTerms: number = MAX_KEYWORD_TERMS): string[] => {
    const seen = new Set<string>();
    const terms: { hasDigit: boolean; position: number; term: string }[] = [];

    for (const [position, token] of tokenize(query).entries()) {
        if (seen.has(token) || STOPWORDS.has(token)) {
            continue;
        }

        const hasDigit = DIGIT_RE.test(token);

        if (token.length < 2 && !hasDigit) {
            continue;
        }

        seen.add(token);
        terms.push({ hasDigit, position, term: token });
    }

    return terms
        .toSorted((a, b) => Number(b.hasDigit) - Number(a.hasDigit) || b.term.length - a.term.length || a.position - b.position)
        .slice(0, maxTerms)
        .map((t) => t.term);
};

/** Occurrences of `term` under the index's matching rule (exact or prefix), floored at 1. */
const termFrequency = (tokens: string[], term: string): number => {
    let tf = 0;

    for (const token of tokens) {
        if (token.startsWith(term)) {
            tf += 1;
        }
    }

    return Math.max(1, tf);
};

export interface KeywordCandidate {
    content: string;
    id: string;
}

export interface KeywordTermHits<T extends KeywordCandidate = KeywordCandidate> {
    /** Chunks the index returned for this term, best first. */
    hits: T[];
    term: string;
}

/**
 * BM25 over the union of per-term hit lists.
 *
 * Document frequency per term is the length of its hit list — exact unless the
 * lookup hit its limit, in which case it is a lower bound and the term is common
 * enough that under-weighting it is harmless. `corpusSize` is the user's total
 * indexed chunk count; if it is smaller than an observed df (stale count), df
 * wins so IDF never goes negative.
 *
 * Term frequency is floored at 1: the index returned the chunk for that term, so
 * it matches even where our tokenizer disagrees with the index (e.g. CJK bigrams).
 */
export const scoreKeywordCandidates = <T extends KeywordCandidate>(termHits: KeywordTermHits<T>[], corpusSize: number): { candidate: T; score: number }[] => {
    const candidates = new Map<string, { candidate: T; matchedTerms: Set<string>; tokens: string[] }>();

    for (const { hits, term } of termHits) {
        for (const hit of hits) {
            let entry = candidates.get(hit.id);

            if (!entry) {
                entry = { candidate: hit, matchedTerms: new Set(), tokens: tokenize(hit.content) };
                candidates.set(hit.id, entry);
            }

            entry.matchedTerms.add(term);
        }
    }

    if (candidates.size === 0) {
        return [];
    }

    let totalLength = 0;

    for (const entry of candidates.values()) {
        totalLength += entry.tokens.length;
    }

    const avgLength = Math.max(1, totalLength / candidates.size);
    const idf = new Map<string, number>();

    for (const { hits, term } of termHits) {
        const df = hits.length;
        const n = Math.max(corpusSize, df, candidates.size);

        idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
    }

    const scored: { candidate: T; score: number }[] = [];

    for (const entry of candidates.values()) {
        const length = Math.max(1, entry.tokens.length);
        let score = 0;

        for (const term of entry.matchedTerms) {
            const tf = termFrequency(entry.tokens, term);

            score += (idf.get(term) ?? 0) * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * length) / avgLength)));
        }

        scored.push({ candidate: entry.candidate, score });
    }

    return scored.toSorted((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
};

export interface FusedResult<T> {
    /** Best (lowest) 1-based rank this item reached in any input list. */
    bestRank: number;
    item: T;
    /** Sum over lists of 1 / (k + rank). */
    score: number;
}

/**
 * Reciprocal Rank Fusion: score(d) = Σ 1 / (k + rank_i(d)), rank 1-based.
 *
 * - Items are identified by `getId`; a duplicate inside ONE list counts once, at
 *   its best rank, so a list cannot vote twice for the same chunk, and later
 *   items keep the rank they would have had without the duplicate.
 * - When an item appears in several lists, the first list's copy is kept.
 * - Empty lists contribute nothing, so fusing with an empty list reproduces the
 *   other list's order.
 * - Ties break on best single-list rank, then on the order the item was first
 *   seen (list order, then position) — deterministic for identical inputs.
 */
export const reciprocalRankFusion = <T>(lists: ReadonlyArray<ReadonlyArray<T>>, getId: (item: T) => string, k: number = RRF_K): FusedResult<T>[] => {
    const fused = new Map<string, FusedResult<T> & { firstSeen: number }>();
    let seenCounter = 0;

    for (const list of lists) {
        const seenInList = new Set<string>();

        for (const item of list) {
            const id = getId(item);

            if (seenInList.has(id)) {
                continue;
            }

            seenInList.add(id);

            // Ranks are compacted over distinct ids, so a duplicate does not push later items down.
            const rank = seenInList.size;
            const contribution = 1 / (k + rank);
            const existing = fused.get(id);

            if (existing) {
                existing.score += contribution;
                existing.bestRank = Math.min(existing.bestRank, rank);
            } else {
                fused.set(id, { bestRank: rank, firstSeen: seenCounter, item, score: contribution });
                seenCounter += 1;
            }
        }
    }

    return [...fused.values()]
        .toSorted((a, b) => b.score - a.score || a.bestRank - b.bestRank || a.firstSeen - b.firstSeen)
        .map(({ bestRank, item, score }) => {
            return { bestRank, item, score };
        });
};
