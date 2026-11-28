/**
 * The terms a Lunora text search reads from a query, for an index with no language (the `messages` index). Lunora's
 * analyzer lower-cases, drops accents, keeps runs of letters and digits, splits Chinese, Japanese and Korean runs into
 * character pairs, drops terms past 256 characters, and keeps each term once, at its last place. It refuses a query with
 * more than {@link MAX_SEARCH_TERMS} terms, and its last term matches as a prefix (`dep` finds `deploy`).
 *
 * Mirrored here because Lunora does not export it; a change upstream that splits a query into more terms only makes
 * {@link capSearchTerms} keep fewer words than it could.
 */

export const MAX_SEARCH_TERMS = 16;

const MAX_TERM_LENGTH = 256;
const WORD = /[\p{L}\p{N}]+/gu;
// A run no term crosses: letters, digits and the marks written on them. Normalised whole, it reads as it does in the text.
const WORD_RUN = /[\p{L}\p{M}\p{N}]+/gu;
// One character with the combining marks written after it (or a run of marks with no character before them).
const CHARACTER = /\P{M}\p{M}*|\p{M}+/gsu;
const CJK_RUN = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;
const CJK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
// Combining marks are dropped, except the ones Cyrillic letters such as й are written with.
const ACCENTS = /(?<=\p{Script=Cyrillic})[\u{300}-\u{305}\u{307}\u{309}-\u{36F}]|(?<!\p{Script=Cyrillic})[\u{300}-\u{36F}]/gu;

const normalize = (text: string): string => text.normalize("NFD").replaceAll(ACCENTS, "").normalize("NFC").toLowerCase();

/**
 * A normalised word with Chinese, Japanese or Korean in it, as the analyzer splits it: other text kept whole, each such
 * run in pairs. Each term carries its offset in the word.
 */
const splitCjk = (word: string): { at: number; term: string }[] => {
    if (!CJK.test(word)) {
        return [{ at: 0, term: word }];
    }

    const out: { at: number; term: string }[] = [];
    let last = 0;

    for (const match of word.matchAll(CJK_RUN)) {
        const characters = [...match[0]];

        if (match.index > last) {
            out.push({ at: last, term: word.slice(last, match.index) });
        }

        last = match.index + match[0].length;

        let at = match.index;

        for (let index = 0; index < Math.max(1, characters.length - 1); index += 1) {
            out.push({ at, term: characters.length === 1 ? match[0] : `${characters[index]}${characters[index + 1]}` });
            at += characters[index]!.length;
        }
    }

    if (last < word.length) {
        out.push({ at: last, term: word.slice(last) });
    }

    return out;
};

// A Greek final sigma: lower-cased only at a word's end, so one character alone reads `σ` where the whole run reads `ς`.
const FINAL_SIGMA_RE = /ς/gu;

/**
 * Where each unit of `normalize(run)` came from in `run`: the run is normalised one character with its marks at a time,
 * and while that reads the same as the whole run normalised (a final sigma counting as a sigma, the one case-folding rule
 * that reads the next character and keeps the length), each unit maps to its character. Otherwise (a sequence that only
 * composes across characters, such as Hangul jamo) every unit maps to the run's start.
 */
const foldedOrigins = (run: string, folded: string): ((index: number) => number) => {
    const origins: number[] = [];
    let joined = "";

    for (const character of run.matchAll(CHARACTER)) {
        const piece = normalize(character[0]);

        joined += piece;

        for (let index = 0; index < piece.length; index += 1) {
            origins.push(character.index);
        }
    }

    return joined.replaceAll(FINAL_SIGMA_RE, "σ") === folded.replaceAll(FINAL_SIGMA_RE, "σ") ? (index) => origins[index] ?? 0 : () => 0;
};

/**
 * Every term of `text` as the index reads it, in order, repeats included. Each run of letters, marks and digits is
 * normalised whole (no term crosses one), so the terms are the index's; a term past {@link MAX_TERM_LENGTH} is dropped, as
 * the index drops it. With `offsets`, each term also carries the offset in `text` where it starts: its word's first
 * character, or its own pair inside a run of Chinese, Japanese or Korean. Without, `at` is 0 and no character is
 * normalised alone, which a search over many prompts cannot afford.
 */
const readTerms = (text: string, offsets: boolean): { at: number; term: string }[] => {
    const out: { at: number; term: string }[] = [];

    for (const run of text.matchAll(WORD_RUN)) {
        const folded = normalize(run[0]);
        const origin = offsets ? foldedOrigins(run[0], folded) : undefined;

        for (const word of folded.matchAll(WORD)) {
            const terms = splitCjk(word[0]);

            for (const { at, term } of terms) {
                if (term.length <= MAX_TERM_LENGTH) {
                    out.push({ at: origin ? run.index + origin(word.index + at) : 0, term });
                }
            }
        }
    }

    return out;
};

/** Every term of `text` with the offset in `text` where it starts ({@link readTerms}): for placing an excerpt, not for a search. */
export const documentTermsAt = (text: string): { at: number; term: string }[] => readTerms(text, true);

/** Every term of `text`, in order, repeats included: what the index stores for a document. */
export const documentTerms = (text: string): string[] => readTerms(text, false).map(({ term }) => term);

/** The terms a search for `text` looks for: each once, at its last place. */
export const queryTerms = (text: string): string[] => {
    const terms = documentTerms(text);
    const seen = new Set<string>();
    const kept: string[] = [];

    for (let index = terms.length - 1; index >= 0; index -= 1) {
        const term = terms[index] as string;

        if (!seen.has(term)) {
            seen.add(term);
            kept.push(term);
        }
    }

    return kept.toReversed();
};

/** `text` cut to the first {@link MAX_SEARCH_TERMS} terms it searches for, so a long query searches its start instead of failing. */
export const capSearchTerms = (text: string): string => {
    const terms = queryTerms(text);

    return terms.length <= MAX_SEARCH_TERMS ? text : terms.slice(0, MAX_SEARCH_TERMS).join(" ");
};

/** Whether a document term matches one of the query's terms as the index matches them: whole, the last one also as a start. */
const termMatches = (candidate: string, query: ReadonlyArray<string>): boolean =>
    query.some((term, index) => (index === query.length - 1 ? candidate.startsWith(term) : candidate === term));

/**
 * Where in `text` the first term of the query appears, matched as {@link matchesQueryTerms} matches it, on the terms the
 * index reads ({@link documentTermsAt}): the offset in `text` itself, not in a cleaned copy. -1 when none does.
 */
export const firstTermIndex = (text: string, query: ReadonlyArray<string>): number =>
    documentTermsAt(text).find(({ term }) => termMatches(term, query))?.at ?? -1;

/** Whether `text` holds every term of the query: each one whole, the last one as the start of a term, as the index matches. */
export const matchesQueryTerms = (text: string, query: ReadonlyArray<string>): boolean => {
    if (query.length === 0) {
        return false;
    }

    const terms = documentTerms(text);
    const last = query.length - 1;

    return query.every((term, index) => terms.some((candidate) => (index === last ? candidate.startsWith(term) : candidate === term)));
};
