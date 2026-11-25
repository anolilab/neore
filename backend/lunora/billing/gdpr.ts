/**
 * Ending the billing of a subject that is going away, on `__root__`, where the
 * payment store's rows live (`billing/webhook.ts`):
 *
 * - a user's Pro in account deletion, wired into
 *   `gdpr/workflows/deletion-workflow.ts` ("cancel-user-billing"). The
 *   `user.baseTier` / `creem*` columns go with the user row. Team subscriptions
 *   belong to the organization and are left alone;
 * - an organization's Team when the organization is deleted, queued by
 *   {@link queueOrganizationBillingCancel} from better-auth's delete route.
 *
 * Cancels the subject's live subscriptions at Creem first — a deleted subject
 * must stop being charged — then deletes their payment-store rows and records a
 * tombstone for the reference, so a webhook that arrives later cannot recreate a
 * row for it (`processCreemWebhook`). The store is keyed by reference (user or
 * organization id), so it still names the subscription after the organization row
 * is gone, and nothing has to be captured before the delete.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { CREEM_API_KEY } from "../env";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";
import { jobSubject } from "./authorize";

const billingLogger = logger.scope("billing");

const BATCH = 200;

/**
 * Delete pages per run. A page is {@link BATCH} rows, so this bounds a single action at 100k rows;
 * a reference past that throws and the workflow step is retried.
 */
const MAX_DELETE_PAGES = 500;

const LIVE_STATES: ReadonlySet<string> = new Set(["active", "past_due", "paused", "trialing"]);

/** Whether `subscription` still bills at Creem, so ending its subject must cancel it. */
export const isCancellable = (subscription: { provider: string; state: string }): boolean =>
    subscription.provider === "creem" && LIVE_STATES.has(subscription.state);

/** The organization better-auth's delete route removed, from the organization it returns; `undefined` otherwise. */
export const deletedOrganizationOf = (path: string | undefined, returned: unknown): string | undefined => {
    if (path !== "/organization/delete" || returned === null || typeof returned !== "object" || returned instanceof Error || !("id" in returned)) {
        return undefined;
    }

    return typeof returned.id === "string" ? returned.id : undefined;
};

/**
 * What deleting a user's account does to an organization's Team plan: cancel it
 * when the user is the one paying for it (their Creem customer is being erased,
 * and nobody else could keep paying it) or when no member is left to use it;
 * otherwise bill the remaining members' seats.
 */
export const teamBillingOnAccountDeletion = ({ isPurchaser, remainingMembers }: { isPurchaser: boolean; remainingMembers: number }): "cancel" | "sync" =>
    isPurchaser || remainingMembers === 0 ? "cancel" : "sync";

/** Queue the cancel of an organization's Team (deleted organization, or see {@link teamBillingOnAccountDeletion}). Never throws. */
export const queueOrganizationBillingCancel = async (organizationId: string): Promise<void> => {
    try {
        await enqueueJob(internal.billing.gdpr.cancelBilling, { referenceId: organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        billingLogger.error("Queueing an organization's Team cancel failed", { error, organizationId });
    }
};

/** Whether `referenceId` was erased: a late webhook for it must not write a row. */
export const isErased = internalQuery
    .input({ referenceId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { referenceId }, ctx }) => Boolean(await ctx.db.billingErasures.findFirst({ where: { referenceId } })));

/** Remove the store rows a late event created for an erased reference. */
export const dropErasedSubscription = internalMutation
    .input({ subscriptionId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { subscriptionId }, ctx }) => {
        const rows = await ctx.db.payment_subscriptions.findMany({ limit: BATCH, where: { provider: "creem", providerSubscriptionId: subscriptionId } });

        await Promise.all(rows.page.map(async (row) => await ctx.db.delete("payment_subscriptions", row._id)));

        return null;
    });

export const deleteBillingRows = internalMutation
    .input({ referenceId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { referenceId }, ctx }) => {
        // The tombstone is written in the same transaction as the deletes, so an erased reference is never
        // half-recorded. It holds only the id, which is what a late webhook needs to be refused.
        if (!(await ctx.db.billingErasures.findFirst({ where: { referenceId } }))) {
            await ctx.db.insert("billingErasures", { erasedAt: Date.now(), referenceId });
        }

        // `payment_referenceRevisions` holds a counter per reference only under `singleSubscriptionPerReference`, which
        // is off here, so it stays empty; it is keyed by the user or organization id, so it is erased all the same.
        const [subscriptions, sessions, customers, usageEvents, referenceRevisions] = await Promise.all([
            ctx.db.payment_subscriptions.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_sessions.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_customers.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_usageEvents.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_referenceRevisions.findMany({ limit: BATCH, where: { referenceId } }),
        ]);
        const pages = [subscriptions.page, sessions.page, customers.page, usageEvents.page, referenceRevisions.page];

        await Promise.all([
            ...subscriptions.page.map(async (row) => await ctx.db.delete("payment_subscriptions", row._id)),
            ...sessions.page.map(async (row) => await ctx.db.delete("payment_sessions", row._id)),
            ...customers.page.map(async (row) => await ctx.db.delete("payment_customers", row._id)),
            ...usageEvents.page.map(async (row) => await ctx.db.delete("payment_usageEvents", row._id)),
            ...referenceRevisions.page.map(async (row) => await ctx.db.delete("payment_referenceRevisions", row._id)),
        ]);

        return { hasMore: pages.some((page) => page.length >= BATCH) };
    });

/** Cancel `referenceId`'s live Creem subscriptions and delete its payment-store rows. Safe to re-run. */
export const cancelBilling = internalAction
    .input({ referenceId: v.string() })
    .output(v.null())
    .action(async ({ args: { referenceId }, ctx }) => {
        const subscriptions = await ctx.payments.store.listSubscriptionsByReference(referenceId);
        const live = subscriptions.filter((subscription) => isCancellable(subscription));

        // A live subscription that cannot be cancelled must fail the step, not let the rows go while it still bills.
        if (live.length > 0 && !CREEM_API_KEY) {
            throw new LunoraError("SERVICE_UNAVAILABLE", "Billing is not configured");
        }

        // The facade is scoped to this one reference: the workflow step has no caller, and the facade's own rule would refuse.
        const payments = ctx.payments.scoped(jobSubject(referenceId));

        for (const subscription of live) {
            // Asked of Creem, not the store: a run that cancelled and then failed before its row deletes is retried, and the
            // store only learns of the cancel from a webhook that may not have landed yet.
            const current = await payments.getSubscriptionStatus(subscription.id);

            if (isCancellable(current)) {
                // Immediate, not at period end: the subject is going away.
                await payments.cancelSubscription(subscription.id, { atPeriodEnd: false });
            }
        }

        for (let page = 0; page < MAX_DELETE_PAGES; page += 1) {
            const { hasMore } = await ctx.runMutation(internal.billing.gdpr.deleteBillingRows, { referenceId });

            if (!hasMore) {
                return null;
            }
        }

        billingLogger.error("Billing rows did not finish deleting", { referenceId });

        throw new LunoraError("SERVICE_UNAVAILABLE", `Billing rows for ${referenceId} did not finish deleting in ${MAX_DELETE_PAGES} pages`);
    });
