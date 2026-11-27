import { describe, expect, it } from "vitest";

import { documentTerms, documentTermsAt } from "./search-terms";

// Text whose terms depend on how it is normalised: case and accents, decomposed marks, final sigma, Cyrillic marks,
// Chinese, Japanese and Korean pairs, Hangul jamo, emoji, invisible characters, an overlong word and other scripts.
const EDGE_CASES = [
    "Café crème, NOIR et Ünïcödé",
    "cafénoir",
    "ΟΔΟΣ οδός Σίσυφος ΣΟΦΟΣ.",
    "Йогурт й й Ёлка",
    "中文分词测试 日本語のテキスト 한국어 텍스트",
    "mixed中文abc日本def",
    "emoji 😀 test 👩‍👩‍👧 done",
    "foo​bar a<b c&d",
    `${"x".repeat(300)} short`,
    "İstanbul DİYARBAKIR",
    "각 jamo",
    "naïve façade coöperate",
    "ﬁne ligature",
    "１２３ fullwidth ＡＢＣ",
    "देवनागरी हिन्दी",
    "مرحبا بالعالم",
];

describe("documentTerms and documentTermsAt", () => {
    it("read the same terms, so a search and an excerpt never disagree on what matched", () => {
        for (const text of EDGE_CASES) {
            expect(
                documentTermsAt(text).map(({ term }) => term),
                text,
            ).toStrictEqual(documentTerms(text));
        }
    });
});
