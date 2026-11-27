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
const LETTER_RE = /\p{L}/u;
const DIGIT_RE = /\p{N}/u;
const NUMBER_RE = /^\p{N}+$/u;
/** Shorter mixes (`5pm`, `B12`) read as a time or a size more often than as an identifier. */
const MIN_CODE_LENGTH = 4;
/** A bare number this long (`77314`) is a tracking or serial number; a year or a count is shorter. */
const MIN_NUMBER_CODE_LENGTH = 5;

/**
 * The tokens with a digit of every identifier in `text`: `2291` of `KX-2291`, `e4012` of `E4012`, `77314`. A year, a
 * count or a time is not one.
 */
const codeTokensOf = (text: string): Set<string> => {
    const codes = new Set<string>();

    for (const [chunk] of normalize(text).matchAll(CHUNK_RE)) {
        const bare = chunk.replaceAll(/[-_./#]/gu, "");
        const mixed = bare.length >= MIN_CODE_LENGTH && LETTER_RE.test(bare) && DIGIT_RE.test(bare);

        if (mixed || (bare.length >= MIN_NUMBER_CODE_LENGTH && NUMBER_RE.test(bare))) {
            for (const token of searchTokensOf(chunk)) {
                if (DIGIT_RE.test(token)) {
                    codes.add(token);
                }
            }
        }
    }

    return codes;
};

/** A salient query term, and whether it is (part of) an identifier. */
export interface SalientTerm {
    code: boolean;
    term: string;
}

/**
 * Every salient term of a query (no stopwords, no single letters), the most distinctive first: identifiers, then words
 * longest first, then numbers and times (`2019`, `5pm`). The first is the query's leading term; the lookups take only the first
 * `MAX_KEYWORD_TERMS`, scoring takes them all.
 */
export const salientTermsOf = (searchText: string): SalientTerm[] => {
    const codes = codeTokensOf(searchText);
    const rank = (term: string): number => {
        if (codes.has(term)) {
            return 0;
        }

        return DIGIT_RE.test(term) ? 2 : 1;
    };

    return extractKeywordTerms(searchText, Infinity, searchTokensOf)
        .toSorted((a, b) => rank(a) - rank(b))
        .map((term) => {
            return { code: codes.has(term), term };
        });
};
