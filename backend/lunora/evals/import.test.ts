import { describe, expect, it } from "vitest";

import { IMPORT_MAX_CHARS, normalizeCaseDraft, parseCaseImport, parseCsvRows } from "./import";

const UNKNOWN_COLUMNS_RE = /Unknown columns: question, answer[\s\S]*"input" column/u;

describe("parseCsvRows", () => {
    it("handles quotes, escaped quotes, commas and newlines inside fields, and CRLF", () => {
        const rows = parseCsvRows('input,expected\r\n"Say ""hi"", please","hi, there"\r\n"two\nlines",x\n');

        expect(rows).toStrictEqual([
            { cells: ["input", "expected"], line: 1 },
            { cells: ['Say "hi", please', "hi, there"], line: 2 },
            { cells: ["two\nlines", "x"], line: 3 },
        ]);
    });

    it("reports the starting line of the row after a multi-line field and skips blank lines", () => {
        const rows = parseCsvRows('input\n"a\nb"\n\nc');

        expect(rows.map((row) => row.line)).toStrictEqual([1, 2, 5]);
    });

    it("throws on an unterminated quote", () => {
        expect(() => parseCsvRows('input\n"never closed')).toThrow("never closed");
    });
});

describe("CSV import", () => {
    it("maps columns, aliases and check columns", () => {
        const csv = [
            "Input,Expected,rubric,expected-sources,contains,max_latency_ms",
            "What is 2+2?,4,Be exact,math.pdf; tables.pdf,4,",
            "Name a colour,,,,,5000",
        ].join("\n");
        const result = parseCaseImport("csv", csv, 10);

        expect(result).toStrictEqual({
            cases: [
                {
                    checks: [{ kind: "contains", value: "4" }],
                    expectedAnswer: "4",
                    expectedSources: ["math.pdf", "tables.pdf"],
                    input: "What is 2+2?",
                    rubric: "Be exact",
                },
                {
                    checks: [{ kind: "max_latency_ms", value: "5000" }],
                    expectedAnswer: undefined,
                    expectedSources: [],
                    input: "Name a colour",
                    rubric: undefined,
                },
            ],
            ok: true,
        });
    });

    it("rejects unknown columns and a missing input column", () => {
        const result = parseCaseImport("csv", "question,answer\nq,a", 10);

        expect(result.ok).toBe(false);
        expect(!result.ok && result.errors.map((error) => error.message).join(" ")).toMatch(UNKNOWN_COLUMNS_RE);
    });

    it("is all-or-nothing and reports every bad row by line", () => {
        const result = parseCaseImport("csv", "input,regex\nok,\n,\nfine,(", 10);

        expect(result).toStrictEqual({
            errors: [
                { line: 3, message: "The input is required" },
                { line: 4, message: "The regex is not a valid pattern" },
            ],
            ok: false,
        });
    });

    it("rejects a row with more fields than the header", () => {
        const result = parseCaseImport("csv", "input\na,b", 10);

        expect(!result.ok && result.errors[0]).toMatchObject({ line: 2 });
    });

    it("refuses more cases than the dataset has room for, and an empty file", () => {
        expect(parseCaseImport("csv", "input\na\nb\nc", 2)).toMatchObject({ ok: false });
        expect(parseCaseImport("csv", "input\n", 2)).toStrictEqual({ errors: [{ line: 1, message: "The file has no cases" }], ok: false });
    });
});

describe("JSONL import", () => {
    it("reads each line, accepting both spellings", () => {
        const jsonl = [
            JSON.stringify({ checks: [{ kind: "contains", value: "Paris" }], expectedAnswer: "Paris", input: "Capital of France?" }),
            "",
            JSON.stringify({ expected_answer: "4", expected_sources: "a.pdf|b.pdf", input: "2+2" }),
            JSON.stringify({ checks: [{ kind: "max_cost_usd", value: 0.01 }], input: "cheap" }),
        ].join("\n");
        const result = parseCaseImport("jsonl", jsonl, 10);

        expect(result.ok).toBe(true);
        expect(result.ok && result.cases.map((draft) => [draft.input, draft.expectedAnswer, draft.expectedSources, draft.checks])).toStrictEqual([
            ["Capital of France?", "Paris", [], [{ kind: "contains", value: "Paris" }]],
            ["2+2", "4", ["a.pdf", "b.pdf"], []],
            ["cheap", undefined, [], [{ kind: "max_cost_usd", value: "0.01" }]],
        ]);
    });

    it("reports malformed lines by line number", () => {
        const result = parseCaseImport(
            "jsonl",
            ['{"input":"ok"}', "{nope", "[1]", '{"input":5}', '{"input":"x","checks":"no"}', '{"input":"y","checks":[{"kind":"bogus","value":"1"}]}'].join(
                "\n",
            ),
            10,
        );

        expect(!result.ok && result.errors).toStrictEqual([
            { line: 2, message: "Not valid JSON" },
            { line: 3, message: "Each line must be a JSON object" },
            { line: 4, message: '"input" must be a string' },
            { line: 5, message: '"checks" must be an array of { kind, value } objects' },
            { line: 6, message: 'Unknown check "bogus"' },
        ]);
    });

    it("refuses an oversized file before parsing it", () => {
        expect(parseCaseImport("jsonl", "x".repeat(IMPORT_MAX_CHARS + 1), 10)).toMatchObject({ ok: false });
    });
});

describe("normalizeCaseDraft", () => {
    it("trims, drops empty optionals and de-duplicates sources", () => {
        expect(normalizeCaseDraft({ expectedAnswer: "  ", expectedSources: [" a ", "a", ""], input: "  hi  ", rubric: "" })).toStrictEqual({
            draft: { checks: [], expectedAnswer: undefined, expectedSources: ["a"], input: "hi", rubric: undefined },
            ok: true,
        });
    });

    it("collects every problem", () => {
        const result = normalizeCaseDraft({
            checks: Array.from({ length: 11 }, () => {
                return { kind: "contains", value: "x" };
            }),
            input: "",
        });

        expect(!result.ok && result.errors).toHaveLength(2);
    });
});
