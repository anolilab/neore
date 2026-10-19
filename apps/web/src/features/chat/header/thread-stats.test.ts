import { describe, expect, it } from "vitest";

import { countReplies, distinctModels, summarizeThreadStats } from "./thread-stats";

const reply = (overrides: Partial<Parameters<typeof summarizeThreadStats>[0][number]> = {}) => {
    return {
        role: "assistant",
        ...overrides,
    };
};

const row = (id: string, order: number, stepOrder: number, extra: { parentMessageId?: string; role?: string } = {}) => {
    return {
        _id: id,
        message: { role: extra.role ?? "assistant" },
        order,
        parentMessageId: extra.parentMessageId,
        stepOrder,
    };
};

describe("summarizeThreadStats", () => {
    it("returns zeros for an empty thread", () => {
        expect(summarizeThreadStats([])).toEqual({
            averageTokensPerSecond: undefined,
            cost: undefined,
            costIsPartial: false,
            inputTokens: 0,
            outputTokens: 0,
            unpricedReplies: 0,
        });
    });

    it("counts only assistant messages", () => {
        const stats = summarizeThreadStats([
            { role: "user", usage: { promptTokens: 999 } },
            reply({ usage: { promptTokens: 10, completionTokens: 5 } }),
            { role: "system" },
        ]);

        expect(stats.inputTokens).toBe(10);
        expect(stats.outputTokens).toBe(5);
    });

    it("averages speed over total tokens and total time, not per reply", () => {
        // Total tokens over total time (410 / 5s = 82 tok/s), not the mean of the per-reply rates (100, 100, 10).
        const stats = summarizeThreadStats([
            reply({ usage: { completionTokens: 100, durationMs: 1000 } }),
            reply({ usage: { completionTokens: 300, durationMs: 3000 } }),
            reply({ usage: { completionTokens: 10, durationMs: 1000 } }),
        ]);

        expect(stats.averageTokensPerSecond).toBeCloseTo((410 / 5000) * 1000);
    });

    it("leaves replies without timing out of the speed", () => {
        const stats = summarizeThreadStats([reply({ usage: { completionTokens: 50 } }), reply({ usage: { completionTokens: 0, durationMs: 500 } })]);

        expect(stats.averageTokensPerSecond).toBeUndefined();
        expect(stats.outputTokens).toBe(50);
    });

    it("reports the total as exact when every reply that spent tokens is priced", () => {
        const stats = summarizeThreadStats([
            reply({ cost: { byok: false, microdollars: 1000, pricingAvailable: true }, usage: { completionTokens: 5, promptTokens: 9 } }),
            reply({ usage: { completionTokens: 0, promptTokens: 0 } }),
        ]);

        expect(stats.costIsPartial).toBe(false);
        expect(stats.unpricedReplies).toBe(0);
    });

    it("marks the total partial when a reply that spent tokens has no cost, and counts it", () => {
        const stats = summarizeThreadStats([
            reply({ cost: { byok: false, microdollars: 1000, pricingAvailable: true }, usage: { completionTokens: 5, promptTokens: 9 } }),
            reply({ usage: { completionTokens: 7, promptTokens: 3 } }),
        ]);

        expect(stats.cost).toEqual({ byok: false, microdollars: 1000, pricingAvailable: true });
        expect(stats.costIsPartial).toBe(true);
        expect(stats.unpricedReplies).toBe(1);
    });

    it("marks the total partial when a priced reply is missing prices", () => {
        const stats = summarizeThreadStats([reply({ cost: { byok: false, microdollars: 0, pricingAvailable: false }, usage: { completionTokens: 2 } })]);

        expect(stats.costIsPartial).toBe(true);
        expect(stats.unpricedReplies).toBe(0);
    });

    it("sums cost and keeps the byok and unpriced flags", () => {
        const stats = summarizeThreadStats([
            reply({ cost: { byok: false, microdollars: 1000, pricingAvailable: true } }),
            reply({ cost: { byok: true, microdollars: 500, pricingAvailable: true } }),
            reply(),
        ]);

        expect(stats.cost).toEqual({ byok: true, microdollars: 1500, pricingAvailable: true });
    });

    it("marks the cost as a floor when one reply was unpriced", () => {
        const stats = summarizeThreadStats([
            reply({ cost: { byok: false, microdollars: 1000, pricingAvailable: true } }),
            reply({ cost: { byok: false, microdollars: 0, pricingAvailable: false } }),
        ]);

        expect(stats.cost?.pricingAvailable).toBe(false);
        expect(stats.cost?.microdollars).toBe(1000);
    });
});

describe("distinctModels", () => {
    it("lists each model once, in first-use order, and skips rows without one", () => {
        const rows = [
            { ...row("a", 1, 0), model: "b" },
            { ...row("u", 2, 0, { role: "user" }), model: "x" },
            { ...row("c", 2, 0), model: "a" },
            { ...row("d", 3, 0), model: "b" },
            row("e", 4, 0),
        ];

        expect(distinctModels(rows)).toEqual(["b", "a"]);
    });

    it("keeps the model of every regenerated alternative that shares a prompt's order", () => {
        // Same `order`, different models: `toUIMessages` would merge these into one turn and keep only "model-b".
        const rows = [
            { ...row("a1", 1, 0), model: "model-a" },
            { ...row("b1", 1, 0, { parentMessageId: "prompt" }), model: "model-b" },
        ];

        expect(countReplies(rows)).toBe(2);
        expect(distinctModels(rows)).toEqual(["model-a", "model-b"]);
    });
});

describe("countReplies", () => {
    it("counts a multi-step reply once", () => {
        expect(countReplies([row("a", 1, 0), row("b", 1, 1), row("c", 1, 2)])).toBe(1);
    });

    it("counts regenerated siblings that share a prompt's order as separate replies", () => {
        // a2 and a3 are alternatives to a1, each parented to the prompt (u1), not to the row before.
        const rows = [row("a1", 1, 0), row("a2", 1, 0, { parentMessageId: "u1" }), row("a3", 1, 0, { parentMessageId: "u1" })];

        expect(countReplies(rows)).toBe(3);
    });

    it("keeps a sibling's own steps with its reply", () => {
        const rows = [row("a1", 1, 0), row("a2", 1, 0, { parentMessageId: "u1" }), row("a3", 1, 1), row("a4", 1, 2)];

        expect(countReplies(rows)).toBe(2);
    });

    it("counts each turn, and ignores user and tool rows", () => {
        const rows = [row("u1", 0, 0, { role: "user" }), row("a1", 1, 0), row("u2", 2, 0, { role: "user" }), row("t", 2, 1, { role: "tool" }), row("a2", 2, 2)];

        expect(countReplies(rows)).toBe(2);
    });
});
