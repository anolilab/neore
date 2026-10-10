import { describe, expect, it } from "vitest";

import { IcuSyntaxError, parseMessage, validateTranslation } from "./icu.mjs";

describe(parseMessage, () => {
    it("collects placeholders, tags and select keys at every depth", () => {
        const signature = parseMessage("<0>{name}</0> has {count, plural, one {# <1/>item} other {# items of {kind, select, a {A} other {B}}}}");

        expect([...signature.placeholders].toSorted()).toStrictEqual(["count:plural", "kind:select", "name:arg"]);
        expect([...signature.tags].toSorted()).toStrictEqual(["</0>", "<0>", "<1/>"]);
        expect(signature.selectKeys.get("kind")).toStrictEqual(["a", "other"]);
    });

    it("accepts number/date styles and plural offsets", () => {
        expect(() => parseMessage("{n, number, ::percent} on {d, date, short} {c, plural, offset:1 =0 {none} other {#}}")).not.toThrow();
    });

    it("treats an apostrophe before a brace as a quote, per ICU", () => {
        expect([...parseMessage("l'{0}' ici").placeholders]).toStrictEqual([]);
        expect([...parseMessage("l’{0}").placeholders]).toStrictEqual(["0:arg"]);
        expect([...parseMessage("it''s {0}").placeholders]).toStrictEqual(["0:arg"]);
        expect([...parseMessage("don't {0}").placeholders]).toStrictEqual(["0:arg"]);
    });

    it.each([
        ["{0", "after argument"],
        ["{n, plural, other {x", "missing closing"],
        ["a } b", "unmatched"],
        ["{{name}}", "empty argument name"],
        ["{n, plural, one {x}}", 'no "other"'],
        ["{n, plural, uno {x} other {y}}", "invalid plural key"],
        ["{n, plural, one {x} one {y} other {z}}", "duplicate"],
        ["{n, fancy}", "unknown argument type"],
        ["<0>open", "unclosed tag"],
        ["<0>a</1>", "unexpected closing tag"],
    ])("rejects %j", (message, expected) => {
        expect(() => parseMessage(message)).toThrow(IcuSyntaxError);
        expect(() => parseMessage(message)).toThrow(expected);
    });

    it("leaves non-numeric angle brackets and a bare # outside plurals alone", () => {
        expect(() => parseMessage("a < b > c <div> #1")).not.toThrow();
    });
});

describe(validateTranslation, () => {
    it("accepts a faithful translation with reordered placeholders", () => {
        expect(validateTranslation("{0} by {1}", "{1} von {0}")).toStrictEqual([]);
    });

    it("accepts locale-specific plural categories", () => {
        const source = "{0, plural, one {1 model} other {# models}}";

        expect(validateTranslation(source, "{0, plural, one {1 model} few {# modele} many {# modeli} other {# modelu}}")).toStrictEqual([]);
        expect(validateTranslation(source, "{0, plural, other {#個のモデル}}")).toStrictEqual([]);
    });

    it("reports missing and unexpected placeholders", () => {
        expect(validateTranslation("Hi {userName}, {0} left", "Hallo {user}, noch {0}")).toStrictEqual([
            "missing placeholder {userName}",
            "unexpected placeholder {user}",
        ]);
    });

    it("reports a translated plural keyword as a type change", () => {
        expect(validateTranslation("{n, plural, other {#}}", "{n}")).toStrictEqual(["missing placeholder {n, plural}", "unexpected placeholder {n}"]);
    });

    it("catches a placeholder swallowed by an apostrophe", () => {
        expect(validateTranslation("the {0}", "l'{0}")).toStrictEqual(["missing placeholder {0}"]);
    });

    it("reports tag changes", () => {
        expect(validateTranslation("Read <0>docs</0>", "Lies <0>Doku</0> <1/>")).toStrictEqual(["unexpected tag <1/>"]);
        expect(validateTranslation("Read <0>docs</0>", "Lies Doku")).toStrictEqual(["missing tag <0>", "missing tag </0>"]);
    });

    it("requires select keys to be kept", () => {
        expect(validateTranslation("{g, select, male {he} female {she} other {they}}", "{g, select, masculin {il} other {iel}}")).toStrictEqual([
            'select "g" must keep keys female, male, other (got masculin, other)',
        ]);
    });

    it("reports syntax errors and empty strings", () => {
        expect(validateTranslation("{0} items", "{0 Elemente")[0]).toMatch(/^invalid ICU syntax/u);
        expect(validateTranslation("x", "  ")).toStrictEqual(["translation is empty"]);
    });
});
