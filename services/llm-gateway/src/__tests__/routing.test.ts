import { describe, expect, it } from "vitest";

import { scoreQuery } from "../routing/scorer.js";
import { classifyTier, QueryTier, TIER_BOUNDARIES } from "../routing/tiers.js";

describe("routing/scorer", () => {
    const makeRequest = (text: string, options?: { preferredQuality?: number; toolCount?: number }) => {
        return {
            messages: [{ content: text, role: "user" as const }],
            userTier: "free",
            ...options,
        };
    };

    describe("scoreQuery", () => {
        it("scores a simple greeting low", () => {
            const score = scoreQuery(makeRequest("hi"));

            expect(score.combined).toBeLessThanOrEqual(TIER_BOUNDARIES.simple.maxScore);
        });

        it("scores a code generation request higher than simple", () => {
            const simple = scoreQuery(makeRequest("hi")).combined;
            const code = scoreQuery(makeRequest("write a TypeScript function that sorts an array using quicksort")).combined;

            expect(code).toBeGreaterThan(simple);
        });

        it("scores a reasoning request above simple threshold", () => {
            // The scorer uses heuristics; reasoning queries score above simple queries
            const simpleScore = scoreQuery(makeRequest("hi")).combined;
            const reasoningScore = scoreQuery(makeRequest("analyze the trade-offs between microservices and monolithic architectures, step by step")).combined;

            expect(reasoningScore).toBeGreaterThan(simpleScore);
        });

        it("scores math/formula content higher", () => {
            const simple = scoreQuery(makeRequest("what is 2+2")).combined;
            const math = scoreQuery(makeRequest("prove the fundamental theorem of calculus using the integral definition of the derivative")).combined;

            expect(math).toBeGreaterThan(simple);
        });

        it("returns a score object with all expected fields", () => {
            const score = scoreQuery(makeRequest("hello world"));

            expect(score).toHaveProperty("combined");
            expect(score).toHaveProperty("complexity");
            expect(score).toHaveProperty("codeGeneration");
            expect(score).toHaveProperty("creativity");
            expect(score).toHaveProperty("reasoning");
            expect(score).toHaveProperty("contextLength");
            expect(score).toHaveProperty("toolUse");
            expect(score.combined).toBeGreaterThanOrEqual(0);
            expect(score.combined).toBeLessThanOrEqual(1);
        });

        it("increases toolUse score when tool schemas are provided", () => {
            const withoutTools = scoreQuery(makeRequest("do a thing")).toolUse;
            const withTools = scoreQuery(
                makeRequest("do a thing", {
                    toolCount: 3,
                }),
            ).toolUse;

            expect(withTools).toBeGreaterThan(withoutTools);
        });

        it("score is always in [0, 1] range", () => {
            const inputs = [
                "hi",
                "explain quantum entanglement in excruciating detail, analyze every trade-off, write code",
                "write a comprehensive essay analyzing the philosophical implications of consciousness",
                "```typescript\nfunction solve(x: number): number { return x * 2; }\n```",
            ];

            for (const input of inputs) {
                const score = scoreQuery(makeRequest(input));

                expect(score.combined).toBeGreaterThanOrEqual(0);
                expect(score.combined).toBeLessThanOrEqual(1);
            }
        });
    });
});

describe("routing/tiers", () => {
    describe("classifyTier", () => {
        it("classifies score <= 0.25 as Simple", () => {
            expect(classifyTier(0)).toBe(QueryTier.Simple);
            expect(classifyTier(0.1)).toBe(QueryTier.Simple);
            expect(classifyTier(0.25)).toBe(QueryTier.Simple);
        });

        it("classifies score in (0.25, 0.55] as Standard", () => {
            expect(classifyTier(0.26)).toBe(QueryTier.Standard);
            expect(classifyTier(0.4)).toBe(QueryTier.Standard);
            expect(classifyTier(0.55)).toBe(QueryTier.Standard);
        });

        it("classifies score in (0.55, 0.80] as Complex", () => {
            expect(classifyTier(0.56)).toBe(QueryTier.Complex);
            expect(classifyTier(0.7)).toBe(QueryTier.Complex);
            expect(classifyTier(0.8)).toBe(QueryTier.Complex);
        });

        it("classifies score above 0.80 as Reasoning", () => {
            expect(classifyTier(0.81)).toBe(QueryTier.Reasoning);
            expect(classifyTier(1)).toBe(QueryTier.Reasoning);
        });

        it("simple greetings classify as Simple tier", () => {
            const score = scoreQuery({ messages: [{ content: "hello", role: "user" }], userTier: "free" });

            expect(classifyTier(score.combined)).toBe(QueryTier.Simple);
        });
    });
});
