import { describe, expect, it } from "vitest";

import { salientTermsOf, searchTokensOf, termCount, termIndexOf } from "./search-terms";

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

describe(termCount, () => {
    const qz = { code: true, tokens: ["qz", "5508"] };

    it("matches an identifier only as a whole run: where it starts and where it ends", () => {
        expect(termCount(termIndexOf("ordered part QZ-5508."), qz)).toBe(1);
        expect(termCount(termIndexOf("serial QZ-5508-9000"), qz)).toBe(0);
        expect(termCount(termIndexOf("AB/QZ-5508"), qz)).toBe(0);
        // A run longer than the index keeps has no tokens: two such runs never match.
        expect(termCount(termIndexOf(`B${"7".repeat(300)}`), { code: true, tokens: [] })).toBe(0);
        // And the other way: a longer identifier is not in a row holding the shorter one.
        expect(termCount(termIndexOf("ordered part QZ-5508"), { code: true, tokens: ["qz", "5508", "9000"] })).toBe(0);
    });
});

describe(salientTermsOf, () => {
    it("drops an identifier longer than the index keeps", () => {
        expect(salientTermsOf(`code A${"1".repeat(300)}`).some(({ code }) => code)).toBe(false);
    });

    it("keeps every identifier, two sharing a part included", () => {
        expect(
            salientTermsOf("is it QZ-5508 or AB-5508")
                .filter(({ code }) => code)
                .map(({ term }) => term),
        ).toEqual(["qz 5508", "ab 5508"]);
    });

    it("leads with an identifier, then the longest word, and puts a year or a count last", () => {
        expect(salientTermsOf("did I order part QZ-5508 in 2019")).toEqual([
            { code: true, term: "qz 5508", tokens: ["qz", "5508"] },
            { code: false, term: "order", tokens: ["order"] },
            { code: false, term: "part", tokens: ["part"] },
            { code: false, term: "2019", tokens: ["2019"] },
        ]);
        // A number alone, however long, is an ordinary term.
        expect(salientTermsOf("which parcel ends in 77314")[0]).toMatchObject({ code: false, term: "parcel" });
        expect(salientTermsOf("meet at 5pm")[0]).toMatchObject({ code: false, term: "meet" });
    });

    it.each([
        "in 2019",
        "3 times",
        "parcel 77314",
        "budget is 15000",
        "since 2026-11",
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
        ["serial WTU-38817", "wtu 38817"],
        ["ECON-204 notes", "econ 204"],
        ["boiler E4012", "e4012"],
        ["release v2.3", "v2 3"],
        ["ticket 12-345", "12 345"],
        ["my PS5 controller", "ps5"],
        ["call 555-123-4567", "555 123 4567"],
    ])("reads %s as an identifier", (searchText, term) => {
        expect(salientTermsOf(searchText)[0]).toMatchObject({ code: true, term });
    });
});
