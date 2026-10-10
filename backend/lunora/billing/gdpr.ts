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
 * must stop being charged — then deletes their payment-store rows. The store is
 * keyed by reference (user or organization id), so it still names the
 * subscription after the organization row is gone, and nothing has to be
 * captured before the delete.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalMutation } from "../_generated/server";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";

const billingLogger = logger.scope("billing");

const BATCH = 200;

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

export const deleteBillingRows = internalMutation
    .input({ referenceId: v.string() })
    .output(v.object({ hasMore: v.boolean() }))
    .mutation(async ({ args: { referenceId }, ctx }) => {
        const [subscriptions, sessions, customers, usageEvents] = await Promise.all([
            ctx.db.payment_subscriptions.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_sessions.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_customers.findMany({ limit: BATCH, where: { referenceId } }),
            ctx.db.payment_usageEvents.findMany({ limit: BATCH, where: { referenceId } }),
        ]);
        const pages = [subscriptions.page, sessions.page, customers.page, usageEvents.page];

        await Promise.all(pages.flat().map(async (row) => await ctx.db.delete(row._id)));

        return { hasMore: pages.some((page) => page.length >= BATCH) };
    });

/** Cancel `referenceId`'s live Creem subscriptions and delete its payment-store rows. Safe to re-run. */
export const cancelBilling = internalAction
    .input({ referenceId: v.string() })
    .output(v.null())
    .action(async ({ args: { referenceId }, ctx }) => {
        const subscriptions = await ctx.payments.store.listSubscriptionsByReference(referenceId);

        for (const subscription of subscriptions) {
            if (!isCancellable(subscription)) {
                continue;
            }

            // Asked of Creem, not the store: a run that cancelled and then failed
            // before its row deletes is retried, and the store only learns of the
            // cancel from a webhook that may not have landed yet.
            const current = await ctx.payments.adapter.getSubscriptionStatus(subscription.id);

            if (isCancellable(current)) {
                // The adapter, not the facade: the facade authorizes against the
                // caller, and a workflow step or queued job has none. Immediate,
                // not at period end — the subject is going away.
                await ctx.payments.adapter.cancelSubscription(subscription.id);
            }
        }

        let hasMore = true;

        while (hasMore) {
            ({ hasMore } = await ctx.runMutation(internal.billing.gdpr.deleteBillingRows, { referenceId }));
        }

        return null;
    });
