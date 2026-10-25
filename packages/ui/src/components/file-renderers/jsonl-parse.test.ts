import { describe, expect, it } from "vitest";

import { parseJsonLines } from "./jsonl-parse";

const LIMITS = { maxProblems: 20, maxRecords: 200 };

describe(parseJsonLines, () => {
    it("parses one record per line and keeps physical line numbers across blank lines", () => {
        const result = parseJsonLines('{"a":1}\n\n[2]\n"three"\n', LIMITS);

        expect(result.records).toStrictEqual([
            { line: 1, value: { a: 1 } },
            { line: 3, value: [2] },
            { line: 4, value: "three" },
        ]);
        expect(result.problems).toStrictEqual([]);
        expect(result.truncated).toBe(false);
    });

    it("handles CRLF line endings and a missing final newline", () => {
        const result = parseJsonLines('{"a":1}\r\n{"b":2}', LIMITS);

        expect(result.records.map((record) => record.value)).toStrictEqual([{ a: 1 }, { b: 2 }]);
        expect(result.problems).toStrictEqual([]);
    });

    it("ignores a leading byte-order mark", () => {
        const result = parseJsonLines('\u{FEFF}{"a":1}\n', LIMITS);

        expect(result.records).toStrictEqual([{ line: 1, value: { a: 1 } }]);
    });

    it("reports a malformed line by number and keeps parsing the rest", () => {
        const result = parseJsonLines('{"ok":1}\n{"broken":\n{"ok":2}\n', LIMITS);

        expect(result.records.map((record) => record.line)).toStrictEqual([1, 3]);
        expect(result.problems).toHaveLength(1);
        expect(result.problems[0]).toMatchObject({ line: 2, preview: '{"broken":' });
        expect(result.problems[0]?.message).not.toBe("");
    });

    it("truncates a long offending line in its preview", () => {
        const longLine = `{"x":"${"a".repeat(500)}`;
        const result = parseJsonLines(longLine, LIMITS);

        expect(result.problems[0]?.preview).toHaveLength(160);
    });

    it("stops at the record cap and says more was not read", () => {
        const text = Array.from({ length: 5 }, (_, index) => `{"n":${index}}`).join("\n");
        const result = parseJsonLines(text, { maxProblems: 20, maxRecords: 3 });

        expect(result.records).toHaveLength(3);
        expect(result.truncated).toBe(true);
    });

    it("is not truncated when the cap equals the number of records", () => {
        const result = parseJsonLines('{"n":1}\n{"n":2}\n', { maxProblems: 20, maxRecords: 2 });

        expect(result.records).toHaveLength(2);
        expect(result.truncated).toBe(false);
    });

    it.each([
        ["trailing blank lines", '{"n":1}\n{"n":2}\n\n  \r\n\n', [1, 2], false],
        ["blank lines between records", '{"n":1}\n\n\n{"n":2}\n', [1, 4], false],
        ["a record after the cap", '{"n":1}\n\n{"n":2}\n\n{"n":3}\n', [1, 3], true],
    ])("with %s, reports the lines read and whether the cap cut the file short", (_name, text, lines, truncated) => {
        const result = parseJsonLines(text, { maxProblems: 20, maxRecords: 2 });

        expect(result.records.map((record) => record.line)).toStrictEqual(lines);
        expect(result.truncated).toBe(truncated);
    });

    it("stops at the problem cap", () => {
        const result = parseJsonLines("nope\nnope\nnope\n{}\n", { maxProblems: 2, maxRecords: 200 });

        expect(result.problems.map((problem) => problem.line)).toStrictEqual([1, 2]);
        expect(result.records).toStrictEqual([]);
        expect(result.truncated).toBe(true);
    });

    it("returns nothing for empty input", () => {
        expect(parseJsonLines("", LIMITS)).toStrictEqual({ problems: [], records: [], truncated: false });
    });
});
