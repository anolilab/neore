import { describe, expect, it } from "vitest";

import { salientTermsOf, searchTokensOf } from "./search-terms";

describe(searchTokensOf, () => {
    it("splits Han, kana and Hangul runs into overlapping pairs, as the search index does", () => {
        expect(searchTokensOf("北京大学は東京にある")).toContain("大学");
        expect(searchTokensOf("大学")).toEqual(["大学"]);
    });

    it("keeps the breve and diaeresis of a Cyrillic letter and drops other marks", () => {
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
        // A number alone, however long, is an ordinary term.
        expect(salientTermsOf("which parcel ends in 77314")[0]).toEqual({ code: false, term: "parcel" });
        expect(salientTermsOf("meet at 5pm")[0]).toEqual({ code: false, term: "meet" });
    });

    it.each([
        "in 2019",
        "3 times",
        "parcel 77314",
        "meeting on 2026-11-27",
        "due 27.11.2026",
        "since 11/27/2026",
        "costs 1,299.00",
        "pi is 3.14159",
        "my 21st birthday",
        "ran 100km",
        "a 1080p screen",
    ])("reads %s as no identifier: a number, a date, a decimal, an ordinal or a unit", (searchText) => {
        expect(salientTermsOf(searchText).some(({ code }) => code)).toBe(false);
    });

    it.each([
        ["serial WTU-38817", "38817"],
        ["ECON-204 notes", "204"],
        ["boiler E4012", "e4012"],
        ["release v2.3", "v2"],
    ])("reads %s as an identifier", (searchText, term) => {
        expect(salientTermsOf(searchText)[0]).toEqual({ code: true, term });
    });
});
