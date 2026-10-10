/**
 * The Team seat sync's decisions and its queueing. Pure functions rather than
 * `lunoraTest`: `organization` and `member` are `.global()` tables the harness
 * cannot write, and it has no `ctx.payments` (see `plans.test.ts`).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { organizationOfMemberChange, queueSeatSync, seatSubscriptionOf, seatUnitsFor } from "./seats";

const subscription = (state: string, quantity = 2) => {
    return { quantity, state };
};

describe(seatSubscriptionOf, () => {
    it("names the subscription of an organization on a paid Team plan", () => {
        expect(seatSubscriptionOf({ baseTier: "pro", creemSubscriptionId: "sub_1" })).toBe("sub_1");
    });

    it.each([
        ["no subscription", { baseTier: "pro", creemSubscriptionId: null }],
        // A canceled Team leaves the id behind but drops the tier (`creemTierPatch`).
        ["a lapsed plan", { baseTier: "free", creemSubscriptionId: "sub_1" }],
        // Enterprise is set by a platform admin and billed outside Creem.
        ["enterprise", { baseTier: "enterprise", creemSubscriptionId: "sub_1" }],
    ])("does nothing for %s", (_, subject) => {
        expect(seatSubscriptionOf(subject)).toBeUndefined();
    });
});

describe(seatUnitsFor, () => {
    it.each(["active", "trialing", "past_due"])("sets the units of a %s subscription to the member count", (state) => {
        expect(seatUnitsFor(5, subscription(state))).toBe(5);
    });

    it("bills at least one seat", () => {
        expect(seatUnitsFor(0, subscription("active"))).toBe(1);
    });

    it("does nothing when the units already match, so a re-run is free", () => {
        expect(seatUnitsFor(2, subscription("active", 2))).toBeUndefined();
    });

    it.each(["canceled", "paused"])("does nothing for a %s subscription", (state) => {
        expect(seatUnitsFor(5, subscription(state))).toBeUndefined();
    });
});

describe(organizationOfMemberChange, () => {
    const member = { id: "m1", organizationId: "org_1", role: "member", userId: "u1" };

    it.each([
        ["/organization/add-member", member],
        ["/organization/leave", member],
        ["/organization/remove-member", { member }],
        ["/organization/accept-invitation", { invitation: { id: "inv_1" }, member }],
    ])("reads the organization %s changed", (path, returned) => {
        expect(organizationOfMemberChange(path, returned)).toBe("org_1");
    });

    it("ignores routes that do not change membership", () => {
        expect(organizationOfMemberChange("/organization/update-member-role", member)).toBeUndefined();
        expect(organizationOfMemberChange(undefined, member)).toBeUndefined();
    });

    it("ignores a failed call", () => {
        expect(organizationOfMemberChange("/organization/leave", new Error("MEMBER_NOT_FOUND"))).toBeUndefined();
        expect(organizationOfMemberChange("/organization/leave", null)).toBeUndefined();
    });
});

describe(queueSeatSync, () => {
    beforeEach(() => {
        jobsQueueMessages.length = 0;
    });

    it("queues the sync on __root__ with only the organization id", async () => {
        await queueSeatSync("org_1");

        expect(jobsQueueMessages).toStrictEqual([
            { body: { args: { organizationId: "org_1" }, functionPath: "billing_seats:syncTeamSeats", shardKey: "__root__" } },
        ]);
    });
});
