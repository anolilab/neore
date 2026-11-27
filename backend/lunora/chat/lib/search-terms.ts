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
const CJK_RUN = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;
const CJK = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
// Combining marks are dropped, except the ones Cyrillic letters such as й are written with.
const ACCENTS = /(?<=\p{Script=Cyrillic})[\u{300}-\u{305}\u{307}\u{309}-\u{36F}]|(?<!\p{Script=Cyrillic})[\u{300}-\u{36F}]/gu;

const normalize = (text: string): string => text.normalize("NFD").replaceAll(ACCENTS, "").normalize("NFC").toLowerCase();

/** A word with Chinese, Japanese or Korean in it, as the analyzer splits it: other text kept whole, each such run in pairs. */
const splitCjk = (word: string): string[] => {
    if (!CJK.test(word)) {
        return [word];
    }

    const out: string[] = [];
    let last = 0;

    for (const match of word.matchAll(CJK_RUN)) {
        const characters = [...match[0]];

        if (match.index > last) {
            out.push(word.slice(last, match.index));
        }

        last = match.index + match[0].length;

        if (characters.length === 1) {
            out.push(match[0]);
            continue;
        }

        for (let index = 0; index + 1 < characters.length; index += 1) {
            out.push(`${characters[index]}${characters[index + 1]}`);
        }
    }

    if (last < word.length) {
        out.push(word.slice(last));
    }

    return out;
};

/** Every term of `text`, in order, repeats included: what the index stores for a document. */
export const documentTerms = (text: string): string[] =>
    (normalize(text).match(WORD) ?? []).flatMap((word) => splitCjk(word)).filter((term) => term.length <= MAX_TERM_LENGTH);

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

/** Whether `text` holds every term of the query: each one whole, the last one as the start of a term, as the index matches. */
export const matchesQueryTerms = (text: string, query: ReadonlyArray<string>): boolean => {
    if (query.length === 0) {
        return false;
    }

    const terms = documentTerms(text);
    const last = query.length - 1;

    return query.every((term, index) => terms.some((candidate) => (index === last ? candidate.startsWith(term) : candidate === term)));
};
