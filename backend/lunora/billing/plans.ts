/**
 * What the Creem products buy, as pure functions the actions and the webhook share.
 *
 * Pro is a PER-USER plan: its reference is the buyer's user id and it lands on
 * `user.baseTier`, so it makes one person premium. Team is per organization:
 * its reference is the organization id, it is billed per seat, and it lands on
 * `organization.baseTier`, which makes every member premium. Pro on an
 * organization would let one seat cover the whole team.
 */
import type { Subscription } from "@lunora/payment";
import { LunoraError } from "lunorash/server";

import { throwForbidden } from "../lib/error-helpers";
import type { Defined } from "../lib/patch";
import { withoutUndefined } from "../lib/patch";

export type PaidPlan = "pro" | "team";

/** The Creem product id of each paid plan (`CREEM_PRODUCT_PRO` / `CREEM_PRODUCT_TEAM`). */
export type PlanProducts = Readonly<Record<PaidPlan, string>>;

/** Where a plan's tier is written: Pro on the buyer, Team on the organization. */
const SUBJECT_OF_PLAN = { pro: "user", team: "organization" } as const satisfies Record<PaidPlan, "organization" | "user">;

/** The paid plan a Creem product id sells, or `undefined` for any other product. */
export const planOfProduct = (productId: string, products: PlanProducts): PaidPlan | undefined => {
    if (productId === "") {
        return undefined;
    }

    if (productId === products.pro) {
        return "pro";
    }

    return productId === products.team ? "team" : undefined;
};

/**
 * States that keep the paid tier. An ALLOWLIST, so a state this code has never
 * seen (a new provider state, a typo) grants nothing. `past_due` keeps the
 * tier while Creem retries the charge; `canceled` follows if it never lands.
 */
const PAID_STATES: ReadonlySet<string> = new Set(["active", "past_due", "trialing"]);

/** The tier `subscription` grants right now: `pro` for a known product in a paid state, else `free`. */
export const tierForSubscription = (subscription: Pick<Subscription, "priceId" | "state">, products: PlanProducts): "free" | "pro" =>
    PAID_STATES.has(subscription.state) && planOfProduct(subscription.priceId, products) !== undefined ? "pro" : "free";

/**
 * What a stored subscription writes, and onto which row: Pro onto the buyer
 * (reference = user id), Team onto the organization (reference = org id).
 * `undefined` for a product that is neither plan — it grants nothing here.
 */
export const subscriptionUpdateOf = (
    subscription: Pick<Subscription, "id" | "priceId" | "referenceId" | "state">,
    { customerId, purchaserId }: { customerId?: string; purchaserId?: string },
    products: PlanProducts,
): (CreemTierUpdate & { referenceId: string; subject: "organization" | "user" }) | undefined => {
    const plan = planOfProduct(subscription.priceId, products);

    if (!plan) {
        return undefined;
    }

    return {
        baseTier: tierForSubscription(subscription, products),
        creemCustomerId: customerId,
        // Only an organization records who paid: its Creem customer is that
        // person's own, so the portal opens for them alone (`portalCustomerFor`).
        // Written with the customer id from the PAID subscription, never at
        // checkout start, where an abandoned checkout would claim another's customer.
        ...(SUBJECT_OF_PLAN[plan] === "organization" && customerId !== undefined && { creemPurchaserId: purchaserId }),
        creemSubscriptionId: subscription.id,
        referenceId: subscription.referenceId,
        subject: SUBJECT_OF_PLAN[plan],
    };
};

export interface CreemTierUpdate {
    baseTier: "free" | "pro";
    creemCustomerId?: string;
    creemPurchaserId?: string;
    creemSubscriptionId: string;
}

/**
 * The patch a subscription's tier implies for its user or organization row, or
 * `null` to leave the row alone. A subscription that is NOT the row's current
 * one may raise the tier but never lower it: after a resubscribe, the old
 * subscription's cancel must not take the new one away. Pure, so re-running it
 * for a redelivered event writes the same values again.
 */
export const creemTierPatch = (row: { creemSubscriptionId?: string }, update: CreemTierUpdate): Defined<CreemTierUpdate> | null => {
    if (update.baseTier === "free" && row.creemSubscriptionId !== undefined && row.creemSubscriptionId !== update.creemSubscriptionId) {
        return null;
    }

    return withoutUndefined({ ...update });
};

/**
 * The organization the caller may buy or manage a TEAM subscription for: their
 * ACTIVE one, and only as its owner — the one role with `billing: update`
 * (`auth/permissions.ts`); an admin may only read billing.
 */
export const billingOrganizationOf = (user: { activeOrganization: { id: string; role: string } | null }): string => {
    const organization = user.activeOrganization;

    if (!organization) {
        throwForbidden("Create or switch to an organization to manage its Team subscription");
    }

    if (organization.role !== "owner") {
        throwForbidden("Only organization owners can manage the subscription");
    }

    return organization.id;
};

/**
 * The Creem customer the caller may open the portal on. An organization's
 * customer is its purchaser's own (Creem keys customers by email): their
 * personal plan, invoices and card — so only that person opens it, never
 * another owner. A user's own row records the user as its purchaser.
 */
export const portalCustomerFor = (callerId: string, subject: { creemCustomerId: string | null; creemPurchaserId: string | null }): string => {
    if (!subject.creemCustomerId) {
        throw new LunoraError("NOT_FOUND", "There is no subscription to manage");
    }

    if (subject.creemPurchaserId !== callerId) {
        throwForbidden("Only the person who subscribed can manage this plan");
    }

    return subject.creemCustomerId;
};
