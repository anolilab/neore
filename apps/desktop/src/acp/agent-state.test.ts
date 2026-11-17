import { describe, expect, it } from "vitest";

import { usageOf } from "./agent-state";

const plain = (text: string): string => text;

describe("usageOf", () => {
    it("reads the context use and window of a usage update", () => {
        expect(usageOf({ sessionUpdate: "usage_update", size: 200_000, used: 12_345 }, plain)).toEqual({ size: 200_000, used: 12_345 });
    });

    it("keeps a cost the agent reported, and only that", () => {
        expect(usageOf({ cost: { amount: 0.42, currency: "USD" }, size: 1000, used: 10 }, plain)).toEqual({
            cost: { amount: 0.42, currency: "USD" },
            size: 1000,
            used: 10,
        });
        expect(usageOf({ cost: null, size: 1000, used: 10 }, plain)).toEqual({ size: 1000, used: 10 });
    });

    it.each([
        ["a missing used", { size: 1000 }],
        ["a missing size", { used: 10 }],
        ["a fraction", { size: 1000.5, used: 10 }],
        ["a negative count", { size: 1000, used: -1 }],
        ["a text count", { size: "1000", used: 10 }],
        ["an unsafe integer", { size: Number.MAX_SAFE_INTEGER + 2, used: 10 }],
    ])("refuses %s", (_name, update) => {
        expect(usageOf({ sessionUpdate: "usage_update", ...update }, plain)).toBeUndefined();
    });

    it("drops a cost that is not a finite non-negative amount with a currency, and keeps the usage", () => {
        for (const cost of [{ amount: -1, currency: "USD" }, { amount: NaN, currency: "USD" }, { amount: 1 }, { amount: 1, currency: "" }, "1 USD"]) {
            expect(usageOf({ cost, size: 1000, used: 10 }, plain)).toEqual({ size: 1000, used: 10 });
        }
    });

    it("cuts a currency code longer than the backend takes", () => {
        const usage = usageOf({ cost: { amount: 1, currency: "USDTOOLONGCODE" }, size: 1, used: 0 }, plain);

        expect(usage?.cost?.currency).toBe("USDTOOLO");
    });

    it("leaves the cost out, rather than relabel it, when the scrub changes the currency code", () => {
        // A four-letter code that matches a configured secret is scrubbed to a marker: the amount would then carry a false currency.
        const scrub = (text: string) => text.replaceAll("USDC", "***");

        expect(usageOf({ cost: { amount: 2, currency: "USDC" }, size: 10, used: 1 }, scrub)).toEqual({ size: 10, used: 1 });
    });
});
