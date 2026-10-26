import { describe, expect, it, vi } from "vitest";

import { MockKVNamespace } from "../__tests__/helpers/mock-kv.js";
import type { QueryScore } from "./dimensions.js";
import { applyMomentum, currentTier, getTierHistory, recordTierDecision } from "./momentum.js";
import { QueryTier, tierMidpoint } from "./tiers.js";

const { Complex, Reasoning, Simple, Standard } = QueryTier;

const asKv = (kv: MockKVNamespace): KVNamespace => kv as unknown as KVNamespace;

/** Only `combined` drives momentum; the other dimensions are passed through untouched. */
const scoreOf = (combined: number): QueryScore => {
    return {
        codeGeneration: 0.1,
        combined,
        complexity: 0.2,
        contextLength: 0.3,
        creativity: 0.4,
        language: "en",
        multimodal: 0,
        preferredQuality: 0.5,
        reasoning: 0.6,
        technicalDomain: 0.7,
        toolUse: 0.8,
        userTier: "pro",
    };
};

describe(applyMomentum, () => {
    // Tier bands: simple 0–0.25, standard 0.25–0.55, complex 0.55–0.8, reasoning 0.8–1.
    describe("on the fence of the dominant tier", () => {
        it.each<{ combined: number; dominant: QueryTier; raw: QueryTier }>([
            { combined: 0.5, dominant: Complex, raw: Standard },
            { combined: 0.48, dominant: Complex, raw: Standard },
            { combined: 0.3, dominant: Simple, raw: Standard },
            { combined: 0.75, dominant: Reasoning, raw: Complex },
            { combined: 0.6, dominant: Standard, raw: Complex },
            { combined: 0.85, dominant: Complex, raw: Reasoning },
        ])("pulls $combined ($raw) to the midpoint of $dominant", ({ combined, dominant, raw }) => {
            const decision = applyMomentum(scoreOf(combined), [dominant, dominant, dominant]);

            expect(decision).toEqual({ biased: true, biasedTo: dominant, combined: tierMidpoint(dominant), rawTier: raw });
        });
    });

    describe("leaves the raw score alone", () => {
        it.each<{ combined: number; history: QueryTier[]; name: string; raw: QueryTier }>([
            { combined: 0.5, history: [], name: "with no history", raw: Standard },
            { combined: 0.5, history: [Complex, Complex], name: "with only two confirmations", raw: Standard },
            { combined: 0.5, history: [Complex, Standard, Simple, Complex, Standard], name: "when no tier has three confirmations", raw: Standard },
            { combined: 0.7, history: [Complex, Complex, Complex], name: "when the raw tier is already the dominant one", raw: Complex },
            { combined: 0.45, history: [Complex, Complex, Complex], name: "when the score is clearly outside the dominant band", raw: Standard },
            { combined: 0.1, history: [Complex, Complex, Complex], name: "when the user pivots to something trivial", raw: Simple },
            { combined: 0.95, history: [Simple, Simple, Simple], name: "when the user pivots to something hard", raw: Reasoning },
        ])("$name", ({ combined, history, raw }) => {
            expect(applyMomentum(scoreOf(combined), history)).toEqual({ biased: false, combined, rawTier: raw });
        });
    });

    it("counts three confirmations anywhere in the history, not only a trailing run", () => {
        const decision = applyMomentum(scoreOf(0.5), [Complex, Standard, Complex, Simple, Complex]);

        expect(decision).toMatchObject({ biased: true, biasedTo: Complex });
    });

    it("lets the most frequent tier win over a more recent one", () => {
        const decision = applyMomentum(scoreOf(0.5), [Complex, Complex, Complex, Simple, Simple]);

        expect(decision).toMatchObject({ biased: true, biasedTo: Complex });
    });

    it("changes the combined score only, and does not mutate its inputs", () => {
        const score = scoreOf(0.5);
        const history = [Complex, Complex, Complex];

        applyMomentum(score, history);

        expect(score).toEqual(scoreOf(0.5));
        expect(history).toEqual([Complex, Complex, Complex]);
    });
});

describe(currentTier, () => {
    it("is the last tier in the history, or null when there is none", () => {
        expect(currentTier([])).toBeNull();
        expect(currentTier([Simple, Complex])).toBe(Complex);
    });
});

describe(getTierHistory, () => {
    it("is empty without a KV binding or a stored history", async () => {
        expect(await getTierHistory(undefined, "u1", "t1")).toEqual([]);
        expect(await getTierHistory(asKv(new MockKVNamespace()), "u1", "t1")).toEqual([]);
    });

    it("returns the stored tiers oldest-first", async () => {
        const kv = new MockKVNamespace();

        kv.setRaw("mtm:u1:t1", JSON.stringify([Simple, Standard, Complex]));

        expect(await getTierHistory(asKv(kv), "u1", "t1")).toEqual([Simple, Standard, Complex]);
    });

    it("drops entries that are not tiers", async () => {
        const kv = new MockKVNamespace();

        kv.setRaw("mtm:u1:t1", JSON.stringify([Simple, "bogus", 3, null, Complex]));

        expect(await getTierHistory(asKv(kv), "u1", "t1")).toEqual([Simple, Complex]);
    });

    it.each([
        ["malformed JSON", "{not json"],
        ["a JSON object", JSON.stringify({ tier: "simple" })],
        ["a JSON string", JSON.stringify("simple")],
    ])("is empty when the stored value is %s", async (_name, raw) => {
        const kv = new MockKVNamespace();

        kv.setRaw("mtm:u1:t1", raw);

        expect(await getTierHistory(asKv(kv), "u1", "t1")).toEqual([]);
    });

    it("is empty when KV throws", async () => {
        const kv = new MockKVNamespace();

        vi.spyOn(kv, "get").mockRejectedValue(new Error("KV down"));

        expect(await getTierHistory(asKv(kv), "u1", "t1")).toEqual([]);
    });
});

describe(recordTierDecision, () => {
    it("appends to the thread's history", async () => {
        const kv = asKv(new MockKVNamespace());

        await recordTierDecision(kv, "u1", "t1", Simple);
        await recordTierDecision(kv, "u1", "t1", Complex);

        expect(await getTierHistory(kv, "u1", "t1")).toEqual([Simple, Complex]);
    });

    it("keeps only the five most recent decisions", async () => {
        const kv = asKv(new MockKVNamespace());
        const decisions = [Simple, Standard, Complex, Reasoning, Simple, Standard, Complex];

        for (const tier of decisions) {
            await recordTierDecision(kv, "u1", "t1", tier);
        }

        expect(await getTierHistory(kv, "u1", "t1")).toEqual(decisions.slice(-5));
    });

    it("keeps one history per user and thread, so a shared device cannot poison another user's routing", async () => {
        const kv = asKv(new MockKVNamespace());

        await recordTierDecision(kv, "u1", "t1", Complex);
        await recordTierDecision(kv, "u2", "t1", Simple);
        await recordTierDecision(kv, "u1", "t2", Reasoning);

        expect(await getTierHistory(kv, "u1", "t1")).toEqual([Complex]);
        expect(await getTierHistory(kv, "u2", "t1")).toEqual([Simple]);
        expect(await getTierHistory(kv, "u1", "t2")).toEqual([Reasoning]);
    });

    it("renews a 30-minute expiry on every write", async () => {
        const kv = new MockKVNamespace();
        const put = vi.spyOn(kv, "put");

        await recordTierDecision(asKv(kv), "u1", "t1", Simple);
        await recordTierDecision(asKv(kv), "u1", "t1", Simple);

        expect(put).toHaveBeenCalledTimes(2);

        for (const call of put.mock.calls) {
            expect(call[2]).toEqual({ expirationTtl: 1800 });
        }
    });

    it("never fails routing: no KV binding, a failing read or a failing write all resolve", async () => {
        const failingGet = new MockKVNamespace();
        const failingPut = new MockKVNamespace();

        vi.spyOn(failingGet, "get").mockRejectedValue(new Error("KV down"));
        vi.spyOn(failingPut, "put").mockRejectedValue(new Error("KV down"));

        await expect(recordTierDecision(undefined, "u1", "t1", Simple)).resolves.toBeUndefined();
        await expect(recordTierDecision(asKv(failingPut), "u1", "t1", Simple)).resolves.toBeUndefined();
        // A read failure reads as an empty history, so the write that follows still lands.
        await expect(recordTierDecision(asKv(failingGet), "u1", "t1", Simple)).resolves.toBeUndefined();
    });

    it("feeds momentum: three recorded decisions bias a borderline score", async () => {
        const kv = asKv(new MockKVNamespace());

        for (let turn = 0; turn < 3; turn++) {
            await recordTierDecision(kv, "u1", "t1", Complex);
        }

        const decision = applyMomentum(scoreOf(0.5), await getTierHistory(kv, "u1", "t1"));

        expect(decision).toMatchObject({ biased: true, biasedTo: Complex });
    });
});
