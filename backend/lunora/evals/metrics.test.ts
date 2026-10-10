import { describe, expect, it } from "vitest";

import {
    aggregateResults,
    compareCase,
    compareRunResults,
    computeRetrievalMetrics,
    DEFAULT_COST_CAP_MICRODOLLARS,
    extractJson,
    JUDGE_PASS_THRESHOLD,
    DEFAULT_TOKEN_BUDGET,
    MAX_COST_CAP_MICRODOLLARS,
    MAX_TOKEN_BUDGET,
    nextCaseBudget,
    parseCostCapUsd,
    parseTokenBudget,
    runCheck,
    scoreCase,
    unpricedCaseTokens,
    validateCheck,
    validateJsonSchema,
} from "./metrics";

/** Retrieved chunks known only by name, as an imported dataset sees them. */
const source = (names: string[]) =>
    names.map((fileName) => {
        return { fileName };
    });

const context = { answer: "The capital of France is Paris.", costMicrodollars: 1500, latencyMs: 800 };

describe("computeRetrievalMetrics", () => {
    it("scores a first-rank hit", () => {
        const metrics = computeRetrievalMetrics(source(["a.pdf", "b.pdf", "c.pdf"]), ["a.pdf"]);

        expect(metrics.hitAtK).toBe(1);
        expect(metrics.mrr).toBe(1);
        expect(metrics.contextPrecision).toBeCloseTo(1 / 3);
        expect(metrics.contextRecall).toBe(1);
        expect(metrics.relevant).toStrictEqual([true, false, false]);
    });

    it("takes the reciprocal rank of the FIRST relevant chunk", () => {
        expect(computeRetrievalMetrics(source(["x", "y", "b", "a"]), ["a", "b"]).mrr).toBeCloseTo(1 / 3);
        expect(computeRetrievalMetrics(source(["x", "a"]), ["a"]).mrr).toBe(0.5);
    });

    it("counts documents, not chunks, for recall, and chunks for precision", () => {
        // Two chunks of a.pdf, none of b.pdf: half the documents, two thirds of the chunks.
        const metrics = computeRetrievalMetrics(source(["a.pdf", "a.pdf", "z.pdf"]), ["a.pdf", "b.pdf"]);

        expect(metrics.contextRecall).toBe(0.5);
        expect(metrics.contextPrecision).toBeCloseTo(2 / 3);
    });

    it("scores a miss as zero everywhere", () => {
        const metrics = computeRetrievalMetrics(source(["x", "y"]), ["a"]);

        expect(metrics).toMatchObject({ contextPrecision: 0, contextRecall: 0, hitAtK: 0, mrr: 0 });
    });

    it("honours k", () => {
        const metrics = computeRetrievalMetrics(source(["x", "y", "a"]), ["a"], 2);

        expect(metrics.hitAtK).toBe(0);
        expect(metrics.mrr).toBe(0);
        expect(computeRetrievalMetrics(source(["x", "y", "a"]), ["a"], 3).hitAtK).toBe(1);
    });

    it("matches names case- and whitespace-insensitively", () => {
        expect(computeRetrievalMetrics(source(["  Report.PDF "]), ["report.pdf"]).hitAtK).toBe(1);
    });

    it("matches an expected file id, and falls back to the name", () => {
        const retrieved = [
            { fileId: "f-other", fileName: "guide.pdf" },
            { fileId: "f-refunds", fileName: "refunds.pdf" },
        ];

        expect(computeRetrievalMetrics(retrieved, ["f-refunds"])).toMatchObject({ contextRecall: 1, hitAtK: 1, mrr: 0.5 });
        expect(computeRetrievalMetrics(retrieved, ["Refunds.pdf"])).toMatchObject({ hitAtK: 1, mrr: 0.5 });
        // An id is not a name: a renamed file still matches by id, and a name no longer present does not.
        expect(computeRetrievalMetrics([{ fileId: "f-refunds", fileName: "refunds-v2.pdf" }], ["f-refunds", "refunds.pdf"])).toMatchObject({
            contextRecall: 0.5,
            hitAtK: 1,
        });
    });

    it("handles nothing retrieved and nothing expected without dividing by zero", () => {
        expect(computeRetrievalMetrics(source([]), ["a"])).toMatchObject({ contextPrecision: 0, contextRecall: 0, hitAtK: 0, mrr: 0 });
        expect(computeRetrievalMetrics(source(["a"]), [])).toMatchObject({ contextPrecision: 0, contextRecall: 0, hitAtK: 0, mrr: 0 });
    });
});

describe("validateJsonSchema", () => {
    const schema = {
        additionalProperties: false,
        properties: {
            name: { minLength: 1, type: "string" },
            score: { maximum: 1, minimum: 0, type: "number" },
            tags: { items: { type: "string" }, maxItems: 2, type: "array" },
            tier: { enum: ["a", "b"] },
        },
        required: ["name", "score"],
        type: "object",
    };

    it("accepts a conforming value", () => {
        expect(validateJsonSchema({ name: "x", score: 0.5, tags: ["t"], tier: "a" }, schema)).toBeUndefined();
    });

    it.each([
        [{ score: 0.5 }, 'missing required property "name"'],
        [{ name: "x", score: 2 }, "$.score: greater than 1"],
        [{ name: "x", score: "high" }, "$.score: expected number, got string"],
        [{ name: "x", score: 0, tags: [1] }, "$.tags[0]: expected string"],
        [{ name: "x", score: 0, tags: ["a", "b", "c"] }, "more than 2 items"],
        [{ name: "x", score: 0, tier: "c" }, "not one of the allowed values"],
        [{ extra: true, name: "x", score: 0 }, 'unexpected property "extra"'],
        [[], "expected object, got array"],
    ])("reports %j", (value, message) => {
        expect(validateJsonSchema(value, schema)).toContain(message);
    });

    it("distinguishes integer from number and supports anyOf and const", () => {
        expect(validateJsonSchema(1.5, { type: "integer" })).toBeDefined();
        expect(validateJsonSchema(2, { type: "integer" })).toBeUndefined();
        expect(validateJsonSchema(null, { anyOf: [{ type: "string" }, { type: "null" }] })).toBeUndefined();
        expect(validateJsonSchema(1, { anyOf: [{ type: "string" }, { type: "null" }] })).toBeDefined();
        expect(validateJsonSchema("yes", { const: "yes" })).toBeUndefined();
    });
});

describe("extractJson", () => {
    it("reads a bare answer or the first fenced block", () => {
        expect(extractJson('{"a":1}')).toStrictEqual({ value: { a: 1 } });
        expect(extractJson('Here you go:\n```json\n{"a":2}\n```')).toStrictEqual({ value: { a: 2 } });
        expect(extractJson("no json here")).toBeUndefined();
    });
});

describe("runCheck", () => {
    it("exact compares trimmed text, case-sensitively", () => {
        expect(runCheck({ kind: "exact", value: " Paris " }, { ...context, answer: "Paris\n" }).pass).toBe(true);
        expect(runCheck({ kind: "exact", value: "paris" }, { ...context, answer: "Paris" }).pass).toBe(false);
    });

    it("contains / not_contains are case-insensitive", () => {
        expect(runCheck({ kind: "contains", value: "PARIS" }, context).pass).toBe(true);
        expect(runCheck({ kind: "not_contains", value: "london" }, context).pass).toBe(true);
        expect(runCheck({ kind: "not_contains", value: "paris" }, context).pass).toBe(false);
    });

    it("regex tests the pattern", () => {
        expect(runCheck({ kind: "regex", value: String.raw`capital of \w+` }, context).pass).toBe(true);
        expect(runCheck({ kind: "regex", value: "^London" }, context).pass).toBe(false);
        expect(runCheck({ kind: "regex", value: "(" }, context)).toMatchObject({ pass: false });
    });

    it("json_schema needs parseable JSON that conforms", () => {
        const schema = JSON.stringify({ required: ["city"], type: "object" });

        expect(runCheck({ kind: "json_schema", value: schema }, { ...context, answer: '{"city":"Paris"}' }).pass).toBe(true);
        expect(runCheck({ kind: "json_schema", value: schema }, { ...context, answer: '{"town":"Paris"}' })).toMatchObject({ pass: false });
        expect(runCheck({ kind: "json_schema", value: schema }, context)).toMatchObject({ detail: "The answer is not valid JSON", pass: false });
    });

    it("latency and cost compare against the limit", () => {
        expect(runCheck({ kind: "max_latency_ms", value: "1000" }, context).pass).toBe(true);
        expect(runCheck({ kind: "max_latency_ms", value: "500" }, context).pass).toBe(false);
        expect(runCheck({ kind: "max_cost_usd", value: "0.002" }, context).pass).toBe(true);
        expect(runCheck({ kind: "max_cost_usd", value: "0.001" }, context).pass).toBe(false);
    });

    it("a cost check with no reported cost is unmeasured, not failed", () => {
        expect(runCheck({ kind: "max_cost_usd", value: "0.01" }, { ...context, costMicrodollars: undefined }).pass).toBeNull();
    });
});

describe("validateCheck", () => {
    it.each([
        [{ kind: "regex", value: "(" }, "not a valid pattern"],
        [{ kind: "json_schema", value: "[1]" }, "must be a JSON object"],
        [{ kind: "json_schema", value: "{" }, "not valid JSON"],
        [{ kind: "max_latency_ms", value: "-1" }, "positive number"],
        [{ kind: "max_cost_usd", value: "abc" }, "positive number"],
        [{ kind: "contains", value: "  " }, "needs a value"],
        [{ kind: "bogus", value: "x" }, "Unknown check"],
    ])("rejects %j", (check, message) => {
        expect(validateCheck(check as never)).toContain(message);
    });

    it("accepts well-formed checks", () => {
        expect(validateCheck({ kind: "regex", value: String.raw`\d+` })).toBeUndefined();
        expect(validateCheck({ kind: "json_schema", value: '{"type":"object"}' })).toBeUndefined();
        expect(validateCheck({ kind: "max_cost_usd", value: "0.05" })).toBeUndefined();
    });
});

describe("scoreCase", () => {
    it("averages the measured parts and ignores unmeasured checks", () => {
        const result = scoreCase({ checks: [{ pass: true }, { pass: false }, { pass: null }], judge: { score: 1 } });

        expect(result.score).toBeCloseTo(0.75);
        expect(result.passed).toBe(false);
    });

    it("passes only when every measured part does", () => {
        expect(scoreCase({ checks: [{ pass: true }], judge: { score: JUDGE_PASS_THRESHOLD } }).passed).toBe(true);
        expect(scoreCase({ checks: [], judge: { score: JUDGE_PASS_THRESHOLD - 0.01 } }).passed).toBe(false);
        expect(scoreCase({ checks: [], faithfulness: { score: 0.2 }, judge: { score: 1 } }).passed).toBe(false);
        expect(scoreCase({ checks: [], retrieval: { contextRecall: 0, hitAtK: 0 } }).passed).toBe(false);
    });

    it("scores nothing when nothing was measured", () => {
        expect(scoreCase({ checks: [{ pass: null }] })).toStrictEqual({ passed: true, score: undefined });
    });
});

describe("aggregateResults", () => {
    it("averages scored results only and counts errors apart", () => {
        const summary = aggregateResults(
            [
                { checks: [{ pass: true }], costMicrodollars: 100, judge: { score: 1 }, latencyMs: 100, passed: true, score: 1, status: "scored" },
                {
                    checks: [{ pass: false }, { pass: null }],
                    costMicrodollars: 300,
                    judge: { score: 0.5 },
                    latencyMs: 300,
                    passed: false,
                    retrieval: { contextPrecision: 0.5, contextRecall: 1, hitAtK: 1, mrr: 0.5 },
                    score: 0.5,
                    status: "scored",
                },
                { costMicrodollars: 50, status: "error" },
                { status: "skipped" },
            ],
            5,
        );

        expect(summary).toMatchObject({
            avgContextPrecision: 0.5,
            avgJudgeScore: 0.75,
            avgLatencyMs: 200,
            avgScore: 0.75,
            checkPassRate: 0.5,
            errored: 1,
            hitRate: 1,
            mrr: 0.5,
            passed: 1,
            passRate: 0.5,
            scored: 2,
            skipped: 1,
            total: 5,
            totalCostMicrodollars: 450,
        });
        expect(summary.avgFaithfulness).toBeNull();
    });

    it("reports null rather than 0 for metrics nothing measured", () => {
        expect(aggregateResults([], 3)).toMatchObject({ avgScore: null, checkPassRate: null, hitRate: null, passRate: null, total: 3 });
    });
});

describe("compareRunResults", () => {
    const scored = (caseId: string, passed: boolean, score: number) => {
        return { caseId, passed, score, status: "scored" as const };
    };

    it("flags pass→fail and large score drops as regressions", () => {
        expect(compareCase("a", scored("a", true, 1), scored("a", false, 0.9)).change).toBe("regressed");
        expect(compareCase("a", scored("a", true, 1), scored("a", true, 0.8)).change).toBe("regressed");
        expect(compareCase("a", scored("a", true, 1), { caseId: "a", status: "error" }).change).toBe("regressed");
    });

    it("flags fail→pass and large gains as improvements, small moves as unchanged", () => {
        expect(compareCase("a", scored("a", false, 0.5), scored("a", true, 0.55)).change).toBe("improved");
        expect(compareCase("a", scored("a", true, 0.7), scored("a", true, 0.75)).change).toBe("unchanged");
    });

    it("counts over the union of both runs' cases", () => {
        const comparison = compareRunResults([scored("a", true, 1), scored("b", false, 0)], [scored("a", false, 0), scored("c", true, 1)]);

        expect(comparison.cases.map((entry) => [entry.caseId, entry.change])).toStrictEqual([
            ["a", "regressed"],
            ["b", "missing"],
            ["c", "missing"],
        ]);
        expect(comparison.regressed).toBe(1);
        expect(comparison.cases[0]!.scoreDelta).toBe(-1);
    });
});

describe("cost cap", () => {
    const spend = { capMicrodollars: 1000, spentMicrodollars: 0, tokenBudget: 50_000, unpricedTokens: 0 };

    it("allows the next case only while the run is under its cap", () => {
        expect(nextCaseBudget(spend)).toBe("ok");
        expect(nextCaseBudget({ ...spend, spentMicrodollars: 999 })).toBe("ok");
        expect(nextCaseBudget({ ...spend, spentMicrodollars: 1000 })).toBe("cost");
        expect(nextCaseBudget({ ...spend, spentMicrodollars: 5000 })).toBe("cost");
    });

    it("bounds unpriced spend by the token budget", () => {
        expect(nextCaseBudget({ ...spend, unpricedTokens: 49_999 })).toBe("ok");
        expect(nextCaseBudget({ ...spend, unpricedTokens: 50_000 })).toBe("tokens");
    });

    it("counts a call's tokens only when it reported no cost, estimating when usage is missing too", () => {
        expect(unpricedCaseTokens(1500, 9000, "x")).toBe(0);
        expect(unpricedCaseTokens(0, 9000, "x")).toBe(0);
        expect(unpricedCaseTokens(undefined, 9000, "x")).toBe(9000);
        expect(unpricedCaseTokens(undefined, undefined, "x".repeat(401))).toBe(101);
    });

    it("parses a token budget within bounds", () => {
        expect(parseTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
        expect(parseTokenBudget(100_000)).toBe(100_000);
        expect(parseTokenBudget(MAX_TOKEN_BUDGET + 1)).toHaveProperty("error");
        expect(parseTokenBudget(9999)).toHaveProperty("error");
        expect(parseTokenBudget(12_345.5)).toHaveProperty("error");
    });

    it("parses a dollar cap into microdollars within bounds", () => {
        expect(parseCostCapUsd(undefined)).toBe(DEFAULT_COST_CAP_MICRODOLLARS);
        expect(parseCostCapUsd(2.5)).toBe(2_500_000);
        expect(parseCostCapUsd(MAX_COST_CAP_MICRODOLLARS / 1_000_000 + 1)).toHaveProperty("error");
        expect(parseCostCapUsd(0)).toHaveProperty("error");
        expect(parseCostCapUsd(NaN)).toHaveProperty("error");
    });
});
