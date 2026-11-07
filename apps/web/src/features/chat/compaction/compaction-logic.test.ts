import { PROMPT_CACHE_COLD_START_TOKENS, PROMPT_CACHE_LIFETIME_MS } from "@neore/ai/models";
import { describe, expect, it } from "vitest";

import { isCompactCommand, isDailyLimitRefusal, shouldOfferCompaction } from "./compaction-logic";

const NOW = 10_000_000_000;
const IDLE = { canCompact: true, contextTokens: PROMPT_CACHE_COLD_START_TOKENS, lastActivityAt: NOW - PROMPT_CACHE_LIFETIME_MS - 1 };

describe("isDailyLimitRefusal", () => {
    it("is true for the daily quota refusal, by its data code or its own code", () => {
        expect.assertions(2);
        expect(isDailyLimitRefusal({ code: "TOO_MANY_REQUESTS", data: { code: "DAILY_MESSAGE_LIMIT_REACHED" } })).toBe(true);
        expect(isDailyLimitRefusal({ code: "DAILY_MESSAGE_LIMIT_REACHED" })).toBe(true);
    });

    it.each([undefined, null, "boom", new Error("network"), { code: "TOO_MANY_REQUESTS" }])("is false for %j", (error) => {
        expect.assertions(1);
        expect(isDailyLimitRefusal(error)).toBe(false);
    });
});

describe("isCompactCommand", () => {
    it.each(["/compact", "  /compact  ", "/COMPACT", "/Compact\n"])("is true for %j", (text) => {
        expect.assertions(1);

        expect(isCompactCommand(text)).toBe(true);
    });

    it.each(["compact", "/compact now", "please /compact", "/compacting", ""])("is false for %j", (text) => {
        expect.assertions(1);

        expect(isCompactCommand(text)).toBe(false);
    });
});

describe("shouldOfferCompaction", () => {
    it("offers it for an owner's big thread idle past the cache lifetime", () => {
        expect.assertions(1);

        expect(shouldOfferCompaction(IDLE, NOW)).toBe(true);
    });

    it("waits for the status", () => {
        expect.assertions(1);

        expect(shouldOfferCompaction(undefined, NOW)).toBe(false);
    });

    it("does not offer it while the cache is still warm", () => {
        expect.assertions(1);

        expect(shouldOfferCompaction({ ...IDLE, lastActivityAt: NOW - PROMPT_CACHE_LIFETIME_MS }, NOW)).toBe(false);
    });

    it("does not offer it for a small context: re-reading it costs next to nothing", () => {
        expect.assertions(1);

        expect(shouldOfferCompaction({ ...IDLE, contextTokens: PROMPT_CACHE_COLD_START_TOKENS - 1 }, NOW)).toBe(false);
    });

    it("does not offer it to someone who cannot compact the thread", () => {
        expect.assertions(1);

        expect(shouldOfferCompaction({ ...IDLE, canCompact: false }, NOW)).toBe(false);
    });

    it("does not offer it again after a compaction made since the last reply", () => {
        expect.assertions(2);

        expect(shouldOfferCompaction({ ...IDLE, compactedAt: NOW - 1 }, NOW)).toBe(false);
        // An older compaction does not hide it: the reply after it is what went cold.
        expect(shouldOfferCompaction({ ...IDLE, compactedAt: IDLE.lastActivityAt - 1 }, NOW)).toBe(true);
    });
});
