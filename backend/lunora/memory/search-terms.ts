/**
 * The words of memory keyword search, split the way the search index splits them, so a term the retrieval looks up
 * and a token it scores are the ones the index holds. Pure, no I/O.
 */
import { extractKeywordTerms } from "../knowledge/hybrid";

// Lunora's analyzer: diacritics dropped, except the breve and diaeresis on a Cyrillic letter (`й`, `ё` stay apart
// from `и`, `е`); runs of Han, kana and Hangul split into overlapping pairs, as the index stores them.
const MARKS_RE = /(?<=\p{Script=Cyrillic})[\u{300}-\u{305}\u{307}\u{309}-\u{36F}]|(?<!\p{Script=Cyrillic})[\u{300}-\u{36F}]/gu;
const NON_ASCII_RE = /[\u{80}-\u{10FFFF}]/u;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;
const CJK_RE = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]/u;
const CJK_RUN_RE = /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}]+/gu;
const MAX_TOKEN_LENGTH = 256;

const normalize = (text: string): string =>
    NON_ASCII_RE.test(text) ? text.normalize("NFD").replaceAll(MARKS_RE, "").normalize("NFC").toLowerCase() : text.toLowerCase();

const splitCjk = (token: string): string[] => {
    const parts: string[] = [];
    let end = 0;

    for (const run of token.matchAll(CJK_RUN_RE)) {
        const chars = [...run[0]];

        if (run.index > end) {
            parts.push(token.slice(end, run.index));
        }

        end = run.index + run[0].length;

        if (chars.length === 1) {
            parts.push(run[0]);
            continue;
        }

        for (let index = 0; index + 1 < chars.length; index += 1) {
            parts.push(chars.slice(index, index + 2).join(""));
        }
    }

    if (end < token.length) {
        parts.push(token.slice(end));
    }

    return parts;
};

/** The tokens the search index stores for `text`. */
export const searchTokensOf = (text: string): string[] => {
    const normalized = normalize(text);
    const tokens = normalized.match(TOKEN_RE) ?? [];

    return (CJK_RE.test(normalized) ? tokens.flatMap((token) => splitCjk(token)) : tokens).filter((token) => token.length <= MAX_TOKEN_LENGTH);
};

/** A word joined of letters and digits, with `-`, `_`, `.`, `/` or `#` inside, such as `KX-2291` or `E4012`. */
const CHUNK_RE = /[\p{L}\p{N}]+(?:[-_./#][\p{L}\p{N}]+)*/gu;
const SEPARATOR_RE = /[-_./#]/gu;
/** Letters, then digits: `KX-2291`, `E4012`, `ECON-204`. Digits first is an ordinal or a unit (`21st`, `100km`, `1080p`). */
const LETTERS_THEN_DIGITS_RE = /^\p{L}+[-_./#]?\p{N}/u;
const DIGIT_RE = /\p{N}/u;
/** `v2.3` and `B12` are identifiers; `v2` is too short to tell from a word. */
const MIN_CODE_LENGTH = 3;
/** Digit groups joined by `-`, `_`, `/` or `#` (`12-345`); a `.` joins a decimal or a date instead. */
const DIGIT_GROUPS_RE = /^\p{N}+(?:[-_/#]\p{N}+)+$/u;
const GROUP_SEPARATOR_RE = /[-_/#]/u;

/** `2026-11-27`, `11/27/2026`, `2026-11`: a year beside groups of at most two digits. */
const isDateShaped = (groups: string[]): boolean =>
    groups.some((group) => group.length === 4) && groups.every((group) => group.length === 4 || group.length <= 2);

const isIdentifier = (chunk: string): boolean => {
    if (chunk.replaceAll(SEPARATOR_RE, "").length >= MIN_CODE_LENGTH && LETTERS_THEN_DIGITS_RE.test(chunk)) {
        return true;
    }

    if (!DIGIT_GROUPS_RE.test(chunk)) {
        return false;
    }

    const groups = chunk.split(GROUP_SEPARATOR_RE);

    return !isDateShaped(groups) && groups.some((group) => group.length >= 3);
};

/**
 * The identifiers of `text`, each once, as the tokens it splits into: `qz 5508` of `QZ-5508`, `e4012` of `E4012`,
 * `v2 3` of `v2.3`, `12 345` of `12-345`. Two that share a part (`QZ-5508`, `AB-5508`) are two identifiers. An
 * identifier is letters then digits, at least 3 of them, or digit groups joined by a separator. A number alone never is
 * one: a year, a count, a price, a decimal or a date (`2026-11-27`); nor a mix that starts with digits, a time, an
 * ordinal or a unit (`5pm`, `21st`, `100km`).
 */
const identifiersOf = (text: string): string[][] => {
    const identifiers = new Map<string, string[]>();

    for (const [chunk] of normalize(text).matchAll(CHUNK_RE)) {
        if (!isIdentifier(chunk)) {
            continue;
        }

        const tokens = searchTokensOf(chunk);

        // A run longer than the index keeps (256 characters) has no tokens left, and is no identifier anyone can find.
        if (tokens.length > 0) {
            identifiers.set(tokens.join(" "), tokens);
        }
    }

    return [...identifiers.values()];
};

/** A salient query term: its key, and the tokens a row must hold. */
export interface SalientTerm {
    /** An identifier: a row holds it only as a whole run of its own (`AB-5508` and `QZ-5508-9000` do not hold `QZ-5508`). */
    code: boolean;
    /** The token, or an identifier's tokens joined by spaces (`qz 5508`). */
    term: string;
    tokens: string[];
}

/** What matching reads of a memory: its tokens, and the tokens of each run of letters and digits joined by separators. */
export interface TermIndex {
    runs: string[][];
    tokens: string[];
}

export const termIndexOf = (text: string): TermIndex => {
    return {
        runs: [...normalize(text).matchAll(CHUNK_RE)].map(([chunk]) => searchTokensOf(chunk)).filter((run) => run.length > 0),
        tokens: searchTokensOf(text),
    };
};

/**
 * How often a memory holds a term: a word as a whole token; an identifier as a whole run, starting and ending where
 * the identifier does, so `QZ-5508` is in `part QZ-5508.` and not in `QZ-5508-9000` or `AB/QZ-5508`.
 */
export const termCount = (index: TermIndex, term: { code: boolean; tokens: ReadonlyArray<string> }): number => {
    if (term.tokens.length === 0) {
        return 0;
    }

    if (!term.code) {
        return index.tokens.filter((token) => token === term.tokens[0]).length;
    }

    return index.runs.filter((run) => run.length === term.tokens.length && run.every((token, position) => token === term.tokens[position])).length;
};

/** Scoring reads at most this much of a search: a pasted document is not a question, and every term costs a pass. */
export const MAX_SCORED_TEXT_LENGTH = 4000;

/** And at most this many distinct salient terms, the most distinctive first. */
export const MAX_SCORED_TERMS = 32;

/**
 * The salient terms of a query (no stopwords, no single letters, each once), the most distinctive first: identifiers,
 * then words longest first, then numbers and times (`2019`, `5pm`); at most `MAX_SCORED_TERMS` of the first
 * `MAX_SCORED_TEXT_LENGTH` characters. The first is the query's leading term; the lookups take only the first
 * `MAX_KEYWORD_TERMS`, scoring takes them all.
 */
export const salientTermsOf = (searchText: string): SalientTerm[] => {
    const text = searchText.slice(0, MAX_SCORED_TEXT_LENGTH);
    const identifiers = identifiersOf(text);
    // The identifier with the longest digit run first, as `extractKeywordTerms` ranks digits; then the earlier one.
    const longestDigits = (tokens: string[]): number => Math.max(0, ...tokens.filter((token) => DIGIT_RE.test(token)).map((token) => token.length));
    const codes = identifiers
        .map((tokens, position) => {
            return { position, tokens };
        })
        .toSorted((a, b) => longestDigits(b.tokens) - longestDigits(a.tokens) || a.position - b.position)
        .map(({ tokens }) => {
            return { code: true, term: tokens.join(" "), tokens };
        });
    // An identifier's tokens are the identifier: its letters (`qz`, `hr`) are no words of their own, or a sibling code
    // (`HR-7501` for `HR-9934`) would share them.
    const inCodes = new Set(identifiers.flat());
    const words = extractKeywordTerms(text, Infinity, searchTokensOf)
        .filter((term) => !inCodes.has(term))
        .toSorted((a, b) => Number(DIGIT_RE.test(a)) - Number(DIGIT_RE.test(b)))
        .map((term) => {
            return { code: false, term, tokens: [term] };
        });

    return [...codes, ...words].slice(0, MAX_SCORED_TERMS);
};
