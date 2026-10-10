import { describe, expect, it } from "vitest";

import {
    caseToForm,
    compactChecks,
    detectImportFormat,
    formatCost,
    formatDelta,
    formatLatency,
    formatPercent,
    formToCasePayload,
    orderForComparison,
    parseSourceList,
    runProgress,
} from "./evals-format";

describe("evals formatting", () => {
    it("formats fractions, costs, latency and deltas", () => {
        expect(formatPercent(0.856)).toBe("86%");
        expect(formatPercent(null)).toBe("—");
        expect(formatCost(1500)).toBe("$0.0015");
        expect(formatCost(2_500_000)).toBe("$2.50");
        expect(formatCost(0)).toBe("$0.00");
        expect(formatLatency(420)).toBe("420 ms");
        expect(formatLatency(2345)).toBe("2.3 s");
        expect(formatDelta(0.12)).toBe("+12");
        expect(formatDelta(-0.05)).toBe("−5");
        expect(formatDelta(0.001)).toBe("0");
    });

    it("computes run progress without dividing by zero", () => {
        expect(runProgress({ caseCount: 4, nextIndex: 1 })).toBe(0.25);
        expect(runProgress({ caseCount: 0, nextIndex: 0 })).toBe(0);
    });

    it("detects the import format from the file name", () => {
        expect(detectImportFormat("cases.JSONL")).toBe("jsonl");
        expect(detectImportFormat("cases.ndjson")).toBe("jsonl");
        expect(detectImportFormat("cases.csv")).toBe("csv");
    });

    it("parses source lists and drops blank checks", () => {
        expect(parseSourceList("a.pdf, b.pdf\nc.pdf; a.pdf")).toStrictEqual(["a.pdf", "b.pdf", "c.pdf"]);
        expect(
            compactChecks([
                { kind: "contains", value: " " },
                { kind: "regex", value: "x" },
            ]),
        ).toStrictEqual([{ kind: "regex", value: "x" }]);
    });

    it("orders two picked runs oldest-first for a comparison", () => {
        const older = { _id: "r1" as never, createdAt: 1 };
        const newer = { _id: "r2" as never, createdAt: 2 };

        expect(orderForComparison([newer, older])).toStrictEqual({ baselineRunId: "r1", candidateRunId: "r2" });
        expect(orderForComparison([older])).toBeUndefined();
    });
});

describe("case form round-trip", () => {
    it("drops blanks and splits sources on the way out", () => {
        const payload = formToCasePayload({
            checks: [
                { kind: "contains", value: "Paris" },
                { kind: "regex", value: "" },
            ],
            expectedAnswer: " ",
            expectedFileIds: ["f1"],
            expectedSources: "a.pdf\nb.pdf",
            input: " Capital? ",
            rubric: "",
        });

        expect(payload).toStrictEqual({
            checks: [{ kind: "contains", value: "Paris" }],
            expectedAnswer: undefined,
            expectedSources: ["f1", "a.pdf", "b.pdf"],
            input: "Capital?",
            rubric: undefined,
        });
        expect(caseToForm({ checks: [], expectedAnswer: null, expectedSources: ["a.pdf", "b.pdf"], input: "q", rubric: null }).expectedSources).toBe(
            "a.pdf\nb.pdf",
        );

        const form = caseToForm({ checks: [], expectedAnswer: null, expectedSources: ["f1", "a.pdf"], input: "q", rubric: null }, new Set(["f1"]));

        expect([form.expectedFileIds, form.expectedSources]).toStrictEqual([["f1"], "a.pdf"]);
    });
});
