import { describe, expect, it } from "vitest";

import { countReplies, summarizeThreadStats } from "./thread-stats";

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
            inputTokens: 0,
            models: [],
            outputTokens: 0,
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

    it("lists each model once, in first-use order, and skips replies without one", () => {
        const stats = summarizeThreadStats([reply({ model: "b" }), reply({ model: "a" }), reply({ model: "b" }), reply()]);

        expect(stats.models).toEqual(["b", "a"]);
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
