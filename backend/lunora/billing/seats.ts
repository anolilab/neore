/**
 * Team seats: keep a Team subscription's Creem units equal to its
 * organization's member count.
 *
 * Every membership change queues {@link syncTeamSeats} through
 * {@link queueSeatSync}: better-auth's organization routes from `auth.ts`
 * (`hooks.after`, {@link organizationOfMemberChange}), and the writers that
 * bypass better-auth — the GDPR deletion steps. The job carries only the organization id and reads
 * the CURRENT count when it runs, so bursts, reorderings and queue redeliveries
 * all converge on the same units; a run that finds them equal does nothing.
 *
 * Through `ctx.payments.adapter` (the facade authorizes against a caller, and a
 * queued job has none). Units change with `proration: "next-invoice"`: the
 * prorated difference lands on the next invoice — no card charge per invite,
 * and a removed seat is credited the same way.
 *
 * Billing never blocks a membership change: the queueing is best-effort and
 * logged, and a failed sync throws so the jobs queue retries it.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { CREEM_API_KEY } from "../env";
import { enqueueJob } from "../lib/job-queue";
import { logger } from "../lib/logger";
import { ROOT_SHARD_KEY } from "../lib/shard-context";

const billingLogger = logger.scope("billing");

/** States a seat change still bills against (a scheduled cancel stays `active` until period end). */
const SEATED_STATES: ReadonlySet<string> = new Set(["active", "past_due", "trialing"]);

/** better-auth organization routes that add or remove a `member` row. */
const MEMBER_CHANGE_PATHS: ReadonlySet<string> = new Set([
    "/organization/accept-invitation",
    "/organization/add-member",
    "/organization/leave",
    "/organization/remove-member",
]);

/**
 * Sync rounds per run. A run re-reads after its own write, so a concurrent
 * run's older count cannot be the last word; this only bounds a membership
 * that keeps moving, and the queue retries the run when it is exhausted.
 */
const MAX_ROUNDS = 3;

/** The Creem subscription whose seats follow the organization, or `undefined` when it has no paid Team plan. */
export const seatSubscriptionOf = (subject: { baseTier: string; creemSubscriptionId: string | null }): string | undefined =>
    subject.baseTier === "pro" && subject.creemSubscriptionId ? subject.creemSubscriptionId : undefined;

/**
 * The units that bill `seats`, or `undefined` when there is nothing to do: the
 * subscription no longer bills (canceled, paused), or its units already match —
 * which is what makes a re-run free.
 */
export const seatUnitsFor = (seats: number, subscription: { quantity: number; state: string }): number | undefined => {
    const units = Math.max(1, seats);

    return subscription.quantity === units || !SEATED_STATES.has(subscription.state) ? undefined : units;
};

/**
 * The organization a better-auth route changed the membership of, read from
 * the member it returns (`{ member }` or the member itself); `undefined` for
 * any other route or a failed call.
 */
export const organizationOfMemberChange = (path: string | undefined, returned: unknown): string | undefined => {
    if (path === undefined || returned === null || typeof returned !== "object" || !MEMBER_CHANGE_PATHS.has(path)) {
        return undefined;
    }

    const member = "member" in returned ? returned.member : returned;
    const organizationId = typeof member === "object" && member !== null && "organizationId" in member ? member.organizationId : undefined;

    return typeof organizationId === "string" ? organizationId : undefined;
};

/** Queue a seat sync for `organizationId`. Never throws: the membership change has already happened. */
export const queueSeatSync = async (organizationId: string): Promise<void> => {
    try {
        // `__root__`, with every other payment call (`checkout.ts`).
        await enqueueJob(internal.billing.seats.syncTeamSeats, { organizationId }, { shardKey: ROOT_SHARD_KEY });
    } catch (error) {
        billingLogger.error("Queueing the Team seat sync failed", { error, organizationId });
    }
};

export const syncTeamSeats = internalAction
    .input({ organizationId: v.string() })
    .output(v.null())
    .action(async ({ args: { organizationId }, ctx }) => {
        if (!CREEM_API_KEY) {
            return null;
        }

        for (let round = 0; round < MAX_ROUNDS; round += 1) {
            const subject = await ctx.runQuery(internal.billing.checkout.getBillingSubject, { id: organizationId, kind: "organization" });
            const subscriptionId = seatSubscriptionOf(subject);

            if (!subscriptionId) {
                return null;
            }

            const units = seatUnitsFor(subject.seats, await ctx.payments.adapter.getSubscriptionStatus(subscriptionId));

            if (units === undefined) {
                return null;
            }

            await ctx.payments.adapter.updateSubscription(subscriptionId, { proration: "next-invoice", quantity: units });
        }

        throw new LunoraError("CONFLICT", `Team seats for ${organizationId} did not settle in ${MAX_ROUNDS} rounds`);
    });
