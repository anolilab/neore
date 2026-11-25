/**
 * Ending the billing of a subject that is going away, on `__root__`, where the
 * payment store's rows live (`billing/webhook.ts`):
 *
 * - a user's Pro in account deletion, wired into
 *   `gdpr/workflows/deletion-workflow.ts` ("cancel-user-billing"). The
 *   `user.baseTier` / `creem*` columns go with the user row. Team subscriptions
 *   belong to the organization and are left alone;
 * - an organization's Team when the organization is deleted, queued by
 *   {@link queueOrganizationBillingCancel} from better-auth's delete route;
 * - an organization's Team when only its purchaser leaves: cancelled and its rows
 *   deleted, but the organization is not erased, so no tombstone is written.
 *
 * Cancels the subject's live subscriptions at Creem first — a deleted subject
 * must stop being charged — then deletes their payment-store rows. When the
 * reference itself is erased, a tombstone is recorded in the same transaction, so
 * a webhook that arrives later cannot recreate a row for it (`processCreemWebhook`).
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

/**
 * Queue the cancel of an organization's Team. `erase` is true only when the organization itself is
 * removed; a purchaser leaving keeps the organization, which must be able to buy Team again. Never throws.
 */
export const queueOrganizationBillingCancel = async (organizationId: string, erase: boolean): Promise<void> => {
    try {
        await enqueueJob(internal.billing.gdpr.cancelBilling, { erase, referenceId: organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        billingLogger.error("Queueing an organization's Team cancel failed", { error, organizationId });
    }
};

/** Whether `referenceId` was erased: a late webhook for it must not write a row. */
export const isErased = internalQuery
    .input({ referenceId: v.string() })
    .output(v.boolean())
    .query(async ({ args: { referenceId }, ctx }) => Boolean(await ctx.db.billingErasures.findFirst({ where: { referenceId } })));

/**
 * Delete one page of `referenceId`'s payment-store rows. With `erase`, also record its tombstone, in the
 * same transaction, so an erased reference is never half-recorded.
 */
export const deleteBillingRows = internalMutation
    .input({ erase: v.boolean(), referenceId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { erase, referenceId }, ctx }) => {
        if (erase && !(await ctx.db.billingErasures.findFirst({ where: { referenceId } }))) {
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

/** Run `deletePage` until it reports no more rows, bounded by {@link MAX_DELETE_PAGES}. Throws when the bound is reached. */
export const deleteAllBillingRows = async (deletePage: () => Promise<{ hasMore: boolean }>, referenceId: string): Promise<void> => {
    for (let page = 0; page < MAX_DELETE_PAGES; page += 1) {
        const { hasMore } = await deletePage();

        if (!hasMore) {
            return;
        }
    }

    billingLogger.error("Billing rows did not finish deleting", { referenceId });

    throw new LunoraError("SERVICE_UNAVAILABLE", `Billing rows for ${referenceId} did not finish deleting in ${MAX_DELETE_PAGES} pages`);
};

/** The facade surface a subject's cancel needs: read the provider, then cancel. */
export interface LiveSubscriptionBilling {
    cancelSubscription: (subscriptionId: string, options: { atPeriodEnd: boolean }) => Promise<unknown>;
    getSubscriptionStatus: (subscriptionId: string) => Promise<{ provider: string; state: string }>;
}

/**
 * Cancel each of `subscriptions` that still bills, immediately. Each is read at Creem first, not taken from the store: a run
 * that cancelled and then failed before its rows were deleted is retried, and the store only learns of a cancel from a webhook.
 */
export const endLiveSubscriptions = async (
    payments: LiveSubscriptionBilling,
    subscriptions: ReadonlyArray<{ id: string; provider: string; state: string }>,
) => {
    for (const subscription of subscriptions) {
        if (!isCancellable(subscription)) {
            continue;
        }

        const current = await payments.getSubscriptionStatus(subscription.id);

        if (isCancellable(current)) {
            await payments.cancelSubscription(subscription.id, { atPeriodEnd: false });
        }
    }
};

/**
 * Cancel `referenceId`'s live Creem subscriptions and delete its payment-store rows. Safe to re-run.
 * `erase` is set when the reference is being deleted, and records its tombstone.
 */
export const cancelBilling = internalAction
    .input({ erase: v.boolean(), referenceId: v.string() })
    .output(v.null())
    .action(async ({ args: { erase, referenceId }, ctx }) => {
        const subscriptions = await ctx.payments.store.listSubscriptionsByReference(referenceId);

        // A live subscription that cannot be cancelled must fail the step, not let the rows go while it still bills.
        if (subscriptions.some((subscription) => isCancellable(subscription)) && !CREEM_API_KEY) {
            throw new LunoraError("SERVICE_UNAVAILABLE", "Billing is not configured");
        }

        // The facade is scoped to this one reference: the workflow step has no caller, and the facade's own rule would refuse.
        await endLiveSubscriptions(ctx.payments.scoped(jobSubject(referenceId)), subscriptions);

        await deleteAllBillingRows(async () => await ctx.runMutation(internal.billing.gdpr.deleteBillingRows, { erase, referenceId }), referenceId);

        return null;
    });
