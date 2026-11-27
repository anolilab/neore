import { describe, expect, it } from "vitest";

import { salientTermsOf, searchTokensOf } from "./search-terms";

describe(searchTokensOf, () => {
    it("splits Han, kana and Hangul runs into overlapping pairs, as the search index does (Qodo 1)", () => {
        expect(searchTokensOf("北京大学は東京にある")).toContain("大学");
        expect(searchTokensOf("大学")).toEqual(["大学"]);
    });

    it("keeps the breve and diaeresis of a Cyrillic letter and drops other marks (Qodo 4)", () => {
        expect(searchTokensOf("Ёж и йод")).toEqual(["ёж", "и", "йод"]);
        expect(searchTokensOf("Café naïve")).toEqual(["cafe", "naive"]);
    });
});

describe(salientTermsOf, () => {
    it("leads with an identifier, then the longest word, and puts a year or a count last", () => {
        expect(salientTermsOf("did I order part QZ-5508 in 2019")).toEqual([
            { code: true, term: "5508" },
            { code: false, term: "order" },
            { code: false, term: "part" },
            { code: false, term: "qz" },
            { code: false, term: "2019" },
        ]);
        expect(salientTermsOf("which parcel ends in 77314")[0]).toEqual({ code: true, term: "77314" });
        expect(salientTermsOf("meet at 5pm")[0]).toEqual({ code: false, term: "meet" });
    });
});
