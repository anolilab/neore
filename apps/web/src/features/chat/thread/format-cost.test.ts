import { describe, expect, it } from "vitest";

import { formatCostUsd, formatCredits } from "./format-cost";

describe(formatCostUsd, () => {
    it("formats zero and negative as $0.00", () => {
        expect(formatCostUsd(0)).toBe("$0.00");
        expect(formatCostUsd(-5)).toBe("$0.00");
    });

    it("floors sub-hundredth-of-a-cent costs", () => {
        expect(formatCostUsd(50)).toBe("<$0.0001");
    });

    it("keeps four decimals below a cent", () => {
        expect(formatCostUsd(1234)).toBe("$0.0012");
    });

    it("keeps three decimals below a dollar", () => {
        expect(formatCostUsd(123_456)).toBe("$0.123");
    });

    it("uses cents from a dollar up", () => {
        expect(formatCostUsd(2_500_000)).toBe("$2.50");
    });
});

describe(formatCredits, () => {
    it("converts microdollars to credits", () => {
        expect(formatCredits(1500, "en")).toBe("1.5");
        expect(formatCredits(1_234_567, "de")).toBe("1.234,57");
    });
});
