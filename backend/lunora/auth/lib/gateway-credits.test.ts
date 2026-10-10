import { afterEach, describe, expect, it, vi } from "vitest";

import { computeGatewayCredits } from "./gateway-credits";

describe(computeGatewayCredits, () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("charges the full cost for platform calls", () => {
        expect(computeGatewayCredits({ billingMode: "platform", costMicrodollars: 25_000 })).toBe(25);
    });

    it("treats a report without billingMode (older gateway) as platform", () => {
        expect(computeGatewayCredits({ costMicrodollars: 25_000 })).toBe(25);
    });

    it("charges the fee rate for byok calls", () => {
        expect(computeGatewayCredits({ billingMode: "byok", byokFeeRate: 0.1, costMicrodollars: 25_000 })).toBe(3);
        expect(computeGatewayCredits({ billingMode: "byok", byokFeeRate: 0.1, costMicrodollars: 20_000 })).toBe(2);
    });

    it("charges nothing for byok at rate 0", () => {
        expect(computeGatewayCredits({ billingMode: "byok", byokFeeRate: 0, costMicrodollars: 25_000 })).toBe(0);
    });

    it("falls back to the default rate and logs for an invalid byok rate", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(computeGatewayCredits({ billingMode: "byok", byokFeeRate: 3, costMicrodollars: 20_000 })).toBe(2);
        expect(error).toHaveBeenCalledOnce();
    });

    it("uses the default rate silently when a byok report carries none", () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

        expect(computeGatewayCredits({ billingMode: "byok", costMicrodollars: 20_000 })).toBe(2);
        expect(error).not.toHaveBeenCalled();
    });

    it("never charges custom endpoints or non-positive costs", () => {
        expect(computeGatewayCredits({ billingMode: "custom", costMicrodollars: 25_000 })).toBe(0);
        expect(computeGatewayCredits({ billingMode: "platform", costMicrodollars: 0 })).toBe(0);
        expect(computeGatewayCredits({ billingMode: "platform", costMicrodollars: NaN })).toBe(0);
    });
});
