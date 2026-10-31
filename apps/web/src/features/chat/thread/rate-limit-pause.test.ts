import { describe, expect, it } from "vitest";

import { announcedWaitMs, formatCountdown, providerLabel } from "./rate-limit-pause";

describe("formatCountdown", () => {
    it.each([
        [42_000, "0:42"],
        [41_001, "0:42"],
        [60_000, "1:00"],
        [600_000, "10:00"],
        [5000, "0:05"],
        [0, "0:00"],
        [-3000, "0:00"],
    ])("%i ms reads %s", (ms, text) => {
        expect(formatCountdown(ms)).toBe(text);
    });
});

describe("announcedWaitMs", () => {
    it("moves in steps of thirty seconds, rounded up", () => {
        expect(announcedWaitMs(42_000)).toBe(60_000);
        expect(announcedWaitMs(60_000)).toBe(60_000);
        expect(announcedWaitMs(60_001)).toBe(90_000);
        expect(announcedWaitMs(1)).toBe(30_000);
    });

    it("is zero when the wait is over", () => {
        expect(announcedWaitMs(0)).toBe(0);
        expect(announcedWaitMs(-5)).toBe(0);
    });

    it("holds one value across a whole step, so a live region speaks once", () => {
        const spoken = new Set<number>();

        for (let remaining = 59_000; remaining > 30_000; remaining -= 1000) {
            spoken.add(announcedWaitMs(remaining));
        }

        expect(spoken.size).toBe(1);
    });
});

describe("providerLabel", () => {
    it("names a provider the registry knows", () => {
        expect(providerLabel("anthropic")).toBe("Anthropic");
    });

    it("capitalises one it does not", () => {
        expect(providerLabel("acme")).toBe("Acme");
    });

    it("has no label for no provider", () => {
        expect(providerLabel(undefined)).toBeUndefined();
        expect(providerLabel("")).toBeUndefined();
    });
});
