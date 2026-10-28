import { MICRODOLLARS_PER_CREDIT } from "../gateway";
import { describe, expect, it } from "vitest";

import { estimateInputCostMicrodollars, estimateTokensFromCharacters } from "./prompt-cache";

describe("estimateInputCostMicrodollars", () => {
    it("prices a re-send at one microdollar per token for each dollar per million", () => {
        // 100k tokens at $3 per million is $0.30: 300,000 microdollars, 300 credits.
        const microdollars = estimateInputCostMicrodollars(100_000, 3);

        expect(microdollars).toBe(300_000);
        expect(microdollars / MICRODOLLARS_PER_CREDIT).toBe(300);
    });

    it("follows the characters estimate the notice uses", () => {
        expect(estimateInputCostMicrodollars(estimateTokensFromCharacters(400_000), 1)).toBe(100_000);
    });
});
