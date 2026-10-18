import { describe, expect, it } from "vitest";

import { checkJson, errorPosition, formatJson, MAX_JSON_CHECK_CHARS } from "./prompt-format";

describe("errorPosition", () => {
    it("reads the line and column that Firefox and newer V8 name", () => {
        expect(errorPosition("{}", "JSON.parse: bad at line 3 column 5 of the JSON data")).toStrictEqual({ column: 5, line: 3 });
        expect(errorPosition("{}", "Expected , at position 1 (line 2 column 3)")).toStrictEqual({ column: 3, line: 2 });
    });

    it("works out the line and column from an offset alone", () => {
        expect(errorPosition('{\n  "a" 1 }', "Unexpected number in JSON at position 8")).toStrictEqual({ column: 7, line: 2 });
        expect(errorPosition("[1,]", "Unexpected token at position 3")).toStrictEqual({ column: 4, line: 1 });
    });

    it("returns null when the message names no position", () => {
        expect(errorPosition("{", "JSON Parse error: Unexpected EOF")).toBeNull();
    });
});

describe("checkJson / formatJson", () => {
    it("reports empty, valid and invalid text with a position", () => {
        expect(checkJson("  ")).toStrictEqual({ status: "empty" });
        expect(checkJson('{"subject":"cat"}')).toStrictEqual({ formatChangesValues: false, status: "valid" });
        expect(checkJson('{\n  "a": 1,\n}').status).toBe("invalid");
    });

    it("refuses input over the cap without parsing it", () => {
        expect(checkJson(`"${"a".repeat(MAX_JSON_CHECK_CHARS)}"`)).toStrictEqual({ status: "too-long" });
    });

    it("pretty-prints valid JSON and keeps mentions and variables inside strings", () => {
        expect(formatJson('{"subject":"@Notes {{input}}","camera":{"lens":"35mm"}}')).toStrictEqual({
            ok: true,
            text: '{\n  "subject": "@Notes {{input}}",\n  "camera": {\n    "lens": "35mm"\n  }\n}',
        });
    });

    it("leaves the text alone when it does not parse", () => {
        expect(formatJson("{").ok).toBe(false);
    });

    it.each([
        ["a number past double precision", '{"n": 1e400}'],
        ["an integer past double precision", '{"n": 12345678901234567890}'],
        ["a duplicate key, which the last value wins", '{"a": 1, "a": 2}'],
        ["integer-like keys that JSON objects reorder", '{"b": 1, "2": 2}'],
        ["an escaped @ that would become a live mention", String.raw`{"s": "\u0040Notes"}`],
        ["a 1.0 written as 1 (a false positive, documented)", '{"n": 1.0}'],
    ])("refuses to format %s", (_, text) => {
        expect(checkJson(text)).toStrictEqual({ formatChangesValues: true, status: "valid" });
        expect(formatJson(text).ok).toBe(false);
    });

    it("formats a plain @Notes mention, which the text already holds as written", () => {
        expect(checkJson('{"s": "@Notes"}')).toStrictEqual({ formatChangesValues: false, status: "valid" });
    });
});
