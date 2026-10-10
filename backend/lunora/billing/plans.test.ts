/**
 * The Creem webhook → organization tier mapping, and who may start a checkout.
 *
 * Pure functions rather than `lunoraTest`: `organization` is a `.global()`
 * table, and the harness has no global (D1) writer (see
 * `auth/lib/gateway-deduction.test.ts`).
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { resolveUserPlan } from "../auth/lib/plan";
import { billingOrganizationOf, creemTierPatch, portalCustomerFor, subscriptionUpdateOf, tierForSubscription } from "./plans";

const PRODUCTS = { pro: "prod_pro", team: "prod_team" };

describe(tierForSubscription, () => {
    it.each([
        ["active", "prod_pro", "pro"],
        ["active", "prod_team", "pro"],
        ["trialing", "prod_pro", "pro"],
        // Creem retries a failed renewal; the tier holds until it cancels.
        ["past_due", "prod_team", "pro"],
        ["canceled", "prod_pro", "free"],
        ["paused", "prod_team", "free"],
        // An allowlist: a state nobody has seen yet grants nothing.
        ["scheduled_cancel", "prod_pro", "free"],
        ["something_new", "prod_pro", "free"],
        ["", "prod_pro", "free"],
        // A product that is neither plan grants nothing.
        ["active", "prod_other", "free"],
        ["active", "", "free"],
    ])("%s on %s → %s", (state, priceId, tier) => {
        expect(tierForSubscription({ priceId, state } as never, PRODUCTS)).toBe(tier);
    });

    it("grants nothing when the plan's product id is not configured", () => {
        expect(tierForSubscription({ priceId: "", state: "active" }, { pro: "", team: "" })).toBe("free");
    });
});

describe(subscriptionUpdateOf, () => {
    const subscription = (priceId: string, referenceId: string, state = "active") => ({ id: "sub_1", priceId, referenceId, state }) as never;

    it("records the paying owner on a Team update, from the paid event, with its customer", () => {
        expect(subscriptionUpdateOf(subscription("prod_team", "org_1"), { customerId: "cust_1", purchaserId: "u1" }, PRODUCTS)).toMatchObject({
            creemCustomerId: "cust_1",
            creemPurchaserId: "u1",
        });
    });

    it("records no purchaser for a personal Pro, or for an event without a customer", () => {
        expect(subscriptionUpdateOf(subscription("prod_pro", "u1"), { customerId: "cust_1", purchaserId: "u1" }, PRODUCTS)).not.toHaveProperty(
            "creemPurchaserId",
        );
        expect(subscriptionUpdateOf(subscription("prod_team", "org_1"), { purchaserId: "u1" }, PRODUCTS)).not.toHaveProperty("creemPurchaserId");
    });

    it("writes a Pro subscription onto the BUYER's user row", () => {
        expect(subscriptionUpdateOf(subscription("prod_pro", "user_1"), { customerId: "cust_1" }, PRODUCTS)).toStrictEqual({
            baseTier: "pro",
            creemCustomerId: "cust_1",
            creemSubscriptionId: "sub_1",
            referenceId: "user_1",
            subject: "user",
        });
    });

    it("writes a Team subscription onto the organization", () => {
        expect(subscriptionUpdateOf(subscription("prod_team", "org_1"), { customerId: "cust_1" }, PRODUCTS)).toMatchObject({
            referenceId: "org_1",
            subject: "organization",
        });
    });

    it("downgrades the same subject when the subscription ends", () => {
        expect(subscriptionUpdateOf(subscription("prod_pro", "user_1", "canceled"), {}, PRODUCTS)).toMatchObject({ baseTier: "free", subject: "user" });
    });

    it("ignores a product that is neither plan", () => {
        expect(subscriptionUpdateOf(subscription("prod_other", "user_1"), { customerId: "cust_1" }, PRODUCTS)).toBeUndefined();
    });

    it("leaves the rest of a 10-person organization on free when one member buys Pro", () => {
        const update = subscriptionUpdateOf(subscription("prod_pro", "user_0"), { customerId: "cust_1" }, PRODUCTS);
        const organization = { baseTier: "free" as const };
        const users = Array.from({ length: 10 }, (_, index) => {
            return {
                _id: `user_${index}`,
                ...(update?.subject === "user" && update.referenceId === `user_${index}` && { baseTier: update.baseTier }),
            };
        });

        expect(users.filter((user) => resolveUserPlan(user, [organization]) === "premium").map((user) => user._id)).toStrictEqual(["user_0"]);
    });
});

describe(creemTierPatch, () => {
    it("stamps the tier and the Creem ids on a first activation", () => {
        expect(creemTierPatch({}, { baseTier: "pro", creemCustomerId: "cust_1", creemSubscriptionId: "sub_1" })).toStrictEqual({
            baseTier: "pro",
            creemCustomerId: "cust_1",
            creemSubscriptionId: "sub_1",
        });
    });

    it("is idempotent: a redelivered event yields the same patch", () => {
        const organization = { creemSubscriptionId: "sub_1" };
        const update = { baseTier: "pro", creemSubscriptionId: "sub_1" } as const;

        expect(creemTierPatch(organization, update)).toStrictEqual(creemTierPatch(organization, update));
    });

    it("drops back to free when the current subscription cancels", () => {
        expect(creemTierPatch({ creemSubscriptionId: "sub_1" }, { baseTier: "free", creemSubscriptionId: "sub_1" })).toStrictEqual({
            baseTier: "free",
            creemSubscriptionId: "sub_1",
        });
    });

    it("ignores the cancel of a subscription the organization has moved off", () => {
        expect(creemTierPatch({ creemSubscriptionId: "sub_team" }, { baseTier: "free", creemSubscriptionId: "sub_pro" })).toBeNull();
    });

    it("lets a new subscription take over", () => {
        expect(creemTierPatch({ creemSubscriptionId: "sub_pro" }, { baseTier: "pro", creemSubscriptionId: "sub_team" })).toStrictEqual({
            baseTier: "pro",
            creemSubscriptionId: "sub_team",
        });
    });
});

describe(billingOrganizationOf, () => {
    it("lets an organization owner buy for their active organization", () => {
        expect(billingOrganizationOf({ activeOrganization: { id: "org_1", role: "owner" } })).toBe("org_1");
    });

    it.each(["admin", "member"])("refuses an organization %s (billing is read-only for them)", (role) => {
        expect(() => billingOrganizationOf({ activeOrganization: { id: "org_1", role } })).toThrow(LunoraError);
    });

    it("refuses a caller with no active organization", () => {
        expect(() => billingOrganizationOf({ activeOrganization: null })).toThrow("organization");
    });
});

describe(portalCustomerFor, () => {
    it("opens the portal for the purchaser", () => {
        expect(portalCustomerFor("u1", { creemCustomerId: "cus_1", creemPurchaserId: "u1" })).toBe("cus_1");
    });

    it("refuses another owner of the organization, and a subject that never subscribed", () => {
        expect(() => portalCustomerFor("u2", { creemCustomerId: "cus_1", creemPurchaserId: "u1" })).toThrow(LunoraError);
        expect(() => portalCustomerFor("u1", { creemCustomerId: null, creemPurchaserId: "u1" })).toThrow("no subscription");
    });
});
