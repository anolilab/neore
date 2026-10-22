/**
 * Yearly checkout is gated by `CREEM_YEARLY_CHECKOUT`, but the yearly ids are always
 * recognised, so a subscription bought while yearly was on can still be cancelled.
 */
import { describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => {
    return {
        CREEM_PRODUCT_PRO: "prod_pro",
        CREEM_PRODUCT_PRO_YEARLY: "prod_pro_year",
        CREEM_PRODUCT_TEAM: "prod_team",
        CREEM_PRODUCT_TEAM_YEARLY: "prod_team_year",
        CREEM_YEARLY_CHECKOUT: "",
    };
});

vi.mock("../env", () => env);

const { checkoutProducts, planProducts } = await import("./products");
const { planOfProduct } = await import("./plans");

describe("product ids", () => {
    it("refuses checkout while a product id is shared between plans or intervals", () => {
        const saved = env.CREEM_PRODUCT_TEAM_YEARLY;

        env.CREEM_PRODUCT_TEAM_YEARLY = "prod_pro";

        expect(() => checkoutProducts()).toThrow("more than one plan or interval");

        env.CREEM_PRODUCT_TEAM_YEARLY = saved;
    });

    it("does not throw in the webhook path: a shared id recognises nothing, and the other plans still do", () => {
        const saved = env.CREEM_PRODUCT_TEAM_YEARLY;

        env.CREEM_PRODUCT_TEAM_YEARLY = "prod_pro";

        expect(() => planProducts()).not.toThrow();
        expect(planOfProduct("prod_pro", planProducts())).toBeUndefined();
        expect(planOfProduct("prod_team", planProducts())).toBe("team");

        env.CREEM_PRODUCT_TEAM_YEARLY = saved;
    });

    it("ignores an unconfigured (empty) id when checking for a collision", () => {
        const saved = env.CREEM_PRODUCT_TEAM_YEARLY;

        env.CREEM_PRODUCT_TEAM_YEARLY = "";

        expect(() => checkoutProducts()).not.toThrow();
        expect(planOfProduct("prod_pro", planProducts())).toBe("pro");

        env.CREEM_PRODUCT_TEAM_YEARLY = saved;
    });
});

describe("yearly gate", () => {
    it("offers no yearly checkout while the flag is off, but still recognises the yearly products", () => {
        expect(checkoutProducts().yearly).toBeUndefined();
        expect(planOfProduct("prod_pro_year", planProducts())).toBe("pro");
        expect(planOfProduct("prod_team_year", planProducts())).toBe("team");
    });

    it("offers yearly checkout once the flag is on", () => {
        env.CREEM_YEARLY_CHECKOUT = "true";

        expect(checkoutProducts().yearly).toStrictEqual({ pro: "prod_pro_year", team: "prod_team_year" });

        env.CREEM_YEARLY_CHECKOUT = "";
    });
});
