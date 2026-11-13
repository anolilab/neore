/**
 * The Creem calls billing makes without going through `ctx.payments`, and nothing else.
 *
 * The facade authorizes every call against a signed-in caller. The Team seat sync is a queued job
 * and the deletion step a workflow action, so neither has one. The portal goes here too: the facade
 * opens it for the customer its own store recorded for the reference, while billing keeps the
 * customer on the user or organization row and lets only the purchaser open it (`portalCustomerFor`).
 *
 * Callers do their own gate first: `billingOrganizationOf` and `portalCustomerFor` for the portal,
 * the job queue and the GDPR workflow for the rest. These are plain functions, not procedures, so no
 * client can reach them, and the adapter itself is never exported. Every call is logged with the
 * reference it acts for.
 */
import type { Subscription } from "@lunora/payment";

import { CREEM_API_KEY, CREEM_TEST_MODE, CREEM_WEBHOOK_SECRET } from "../env";
import { logger } from "../lib/logger";
import { buildCreemAdapter } from "./creem-adapter";

const billingLogger = logger.scope("billing");

let adapter: ReturnType<typeof buildCreemAdapter> | undefined;

const creem = (): ReturnType<typeof buildCreemAdapter> => {
    adapter ??= buildCreemAdapter({ apiKey: CREEM_API_KEY, testMode: CREEM_TEST_MODE, webhookSecret: CREEM_WEBHOOK_SECRET });

    return adapter;
};

/** Creem's current view of `subscriptionId`, which `referenceId` holds. */
export const subscriptionStatus = async (referenceId: string, subscriptionId: string): Promise<Subscription> => {
    billingLogger.info("Reading a subscription from Creem", { referenceId, subscriptionId });

    return creem().getSubscriptionStatus(subscriptionId);
};

/** Set a Team subscription's seats. The difference lands on the next invoice, so an invite never charges the card. */
export const setSeats = async (referenceId: string, subscriptionId: string, quantity: number): Promise<Subscription> => {
    billingLogger.info("Setting Team seats in Creem", { quantity, referenceId, subscriptionId });

    return creem().updateSubscription(subscriptionId, { proration: "next-invoice", quantity });
};

/** Cancel now, not at period end: the subject is being deleted. */
export const cancelForDeletion = async (referenceId: string, subscriptionId: string): Promise<Subscription> => {
    billingLogger.info("Cancelling a deleted subject's subscription in Creem", { referenceId, subscriptionId });

    return creem().cancelSubscription(subscriptionId);
};

/** A hosted portal link for `customerId`, which the caller has already been checked to own. */
export const portalLink = async (referenceId: string, customerId: string, returnUrl: string): Promise<{ url: string }> => {
    billingLogger.info("Opening the Creem customer portal", { referenceId });

    return creem().createPortalSession({ customerId, referenceId, returnUrl });
};
