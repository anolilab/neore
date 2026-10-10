/**
 * Cancelling a deleted subject's billing: which subscriptions are cancelled,
 * which better-auth calls delete an organization, and the queued job. Pure
 * functions: the harness has no `ctx.payments` (see `plans.test.ts`).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { jobsQueueMessages } from "../../test/stubs/cloudflare-workers";
import { deletedOrganizationOf, isCancellable, queueOrganizationBillingCancel, teamBillingOnAccountDeletion } from "./gdpr";

describe(isCancellable, () => {
    it.each(["active", "past_due", "paused", "trialing"])("cancels a %s Creem subscription", (state) => {
        expect(isCancellable({ provider: "creem", state })).toBe(true);
    });

    it("leaves an already-canceled subscription alone, so a re-run is a no-op", () => {
        expect(isCancellable({ provider: "creem", state: "canceled" })).toBe(false);
    });

    it("leaves another provider's subscription alone", () => {
        expect(isCancellable({ provider: "stripe", state: "active" })).toBe(false);
    });
});

describe(deletedOrganizationOf, () => {
    const organization = { createdAt: new Date(0), id: "org_1", name: "Acme", slug: "acme" };

    it("reads the organization the delete route returned", () => {
        expect(deletedOrganizationOf("/organization/delete", organization)).toBe("org_1");
    });

    it("ignores a failed delete", () => {
        expect(deletedOrganizationOf("/organization/delete", Object.assign(new Error("FORBIDDEN"), { id: "org_1" }))).toBeUndefined();
        expect(deletedOrganizationOf("/organization/delete", null)).toBeUndefined();
    });

    it("ignores every other route", () => {
        expect(deletedOrganizationOf("/organization/update", organization)).toBeUndefined();
        expect(deletedOrganizationOf("/organization/leave", { id: "m1", organizationId: "org_1" })).toBeUndefined();
        expect(deletedOrganizationOf(undefined, organization)).toBeUndefined();
    });
});

describe(queueOrganizationBillingCancel, () => {
    beforeEach(() => {
        jobsQueueMessages.length = 0;
    });

    it("queues the cancel on __root__, keyed by the organization as the payment reference", async () => {
        await queueOrganizationBillingCancel("org_1");

        expect(jobsQueueMessages).toStrictEqual([
            { body: { args: { referenceId: "org_1" }, functionPath: "billing_gdpr:cancelBilling", shardKey: "__root__" } },
        ]);
    });
});

describe(teamBillingOnAccountDeletion, () => {
    it("cancels a Team the deleted user pays for, even with members left", () => {
        expect(teamBillingOnAccountDeletion({ isPurchaser: true, remainingMembers: 4 })).toBe("cancel");
    });

    it("cancels a Team left without members", () => {
        expect(teamBillingOnAccountDeletion({ isPurchaser: false, remainingMembers: 0 })).toBe("cancel");
    });

    it("re-bills the seats of an organization that keeps members and a payer", () => {
        expect(teamBillingOnAccountDeletion({ isPurchaser: false, remainingMembers: 3 })).toBe("sync");
    });
});
