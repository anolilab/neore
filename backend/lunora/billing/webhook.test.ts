import { describe, expect, it } from "vitest";

import { subscriptionEventOf } from "./webhook";

describe(subscriptionEventOf, () => {
    it("reads a subscription event", () => {
        const body = JSON.stringify({ eventType: "subscription.active", object: { customer: { id: "cus_1" }, id: "sub_1", metadata: { purchaserId: "u1" } } });

        expect(subscriptionEventOf(body)).toStrictEqual({ customerId: "cus_1", purchaserId: "u1", subscriptionId: "sub_1" });
    });

    it("reads the checkout that started a subscription, which adopts it when its events came first", () => {
        const body = JSON.stringify({
            eventType: "checkout.completed",
            object: { customer: "cus_1", id: "ch_1", metadata: { purchaserId: "u1" }, subscription: { id: "sub_1" } },
        });

        expect(subscriptionEventOf(body)).toStrictEqual({ customerId: "cus_1", purchaserId: "u1", subscriptionId: "sub_1" });
    });

    it("ignores other events and a one-off checkout", () => {
        expect(subscriptionEventOf(JSON.stringify({ eventType: "refund.created", object: { id: "r_1" } }))).toBeUndefined();
        expect(subscriptionEventOf(JSON.stringify({ eventType: "checkout.completed", object: { id: "ch_1" } }))).toBeUndefined();
    });
});
