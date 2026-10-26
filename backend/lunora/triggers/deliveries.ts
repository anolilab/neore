/**
 * The permanent delivery record of a `gitlab-token` webhook trigger.
 *
 * GitLab sends the same bearer token on every delivery and signs nothing, so the
 * 15-minute claim window (`lib/claim-once.ts`) leaves a captured delivery
 * replayable once it has passed. A trigger of that scheme therefore keeps one
 * row per accepted delivery for its whole life, keyed on GitLab's
 * `X-Gitlab-Event-UUID` and the SHA-256 of the body. The body is part of the key
 * because GitLab documents that recursive webhooks (one fired by the effect of an
 * earlier one) share a single event UUID: the UUID alone would refuse a distinct
 * delivery. A replay repeats both.
 *
 * The record dies with the trigger: `deleteTrigger` clears it in batches and
 * `eraseTriggersForUser` (`gdpr.ts`) on account deletion.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";

/** Longest `X-Gitlab-Event-UUID` accepted; GitLab sends 36 characters. */
export const MAX_DELIVERY_ID_LENGTH = 128;

/** Records deleted per call by {@link purgeDeliveries}; a full batch schedules the next. */
export const DELIVERY_PURGE_BATCH = 500;

/** Hex SHA-256. */
const DIGEST_LENGTH = 64;

/**
 * Takes the record of a delivery, or answers `null` when this trigger already
 * accepted it. The lookup and the insert share one mutation, which is what makes
 * two concurrent deliveries of the same pair resolve to a single winner (the
 * same guarantee `claimFence` relies on). The returned id is the handle
 * {@link releaseWebhookDelivery} gives the record back with.
 */
export const claimWebhookDelivery = internalMutation
    .input({
        bodyDigest: v.string().max(DIGEST_LENGTH),
        deliveryId: v.string().max(MAX_DELIVERY_ID_LENGTH),
        triggerId: v.id("triggers"),
    })
    .output(v.union(v.null(), v.id("webhookDeliveries")))
    .mutation(async ({ args: { bodyDigest, deliveryId, triggerId }, ctx }) => {
        // The trigger may have been deleted after the handler read it. Its deletion
        // cleared its records, so a row written now would outlive it for good.
        if (!(await ctx.db.get(triggerId))) {
            throw new LunoraError("NOT_FOUND", "Trigger not found");
        }

        const existing = await ctx.db
            .query("webhookDeliveries")
            .withIndex("by_triggerId_deliveryId_bodyDigest", (q) => q.eq("triggerId", triggerId).eq("deliveryId", deliveryId).eq("bodyDigest", bodyDigest))
            .first();

        if (existing) {
            return null;
        }

        return await ctx.db.insert("webhookDeliveries", { bodyDigest, createdAt: ctx.now, deliveryId, triggerId });
    });

/**
 * Gives a record back: the delivery ran nothing (filtered, scheduling failed), so
 * the sender's retry of it must not read as a replay. Addressed by row id, so a
 * release that arrives late cannot remove the record a redelivery has since taken.
 */
export const releaseDelivery = async (ctx: Pick<MutationCtx, "db">, recordId: Id<"webhookDeliveries">): Promise<void> => {
    if (await ctx.db.get(recordId)) {
        await ctx.db.delete(recordId);
    }
};

export const releaseWebhookDelivery = internalMutation
    .input({ recordId: v.id("webhookDeliveries") })
    .output(v.null())
    .mutation(async ({ args: { recordId }, ctx }) => {
        await releaseDelivery(ctx, recordId);

        return null;
    });

/** Deletes up to `limit` of a trigger's records and says whether it may have left some. */
export const deleteDeliveries = async (ctx: Pick<MutationCtx, "db">, triggerId: Id<"triggers">, limit: number): Promise<boolean> => {
    const rows = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_triggerId_deliveryId_bodyDigest", (q) => q.eq("triggerId", triggerId))
        .take(limit);

    await Promise.all(rows.map(async (row) => await ctx.db.delete(row._id)));

    return rows.length >= limit;
};

/**
 * The rest of a deleted trigger's records, one bounded batch per call, scheduling
 * itself while batches come back full. A trigger that still exists keeps its record.
 */
export const purgeDeliveries = internalMutation
    .input({ triggerId: v.id("triggers") })
    .output(v.null())
    .mutation(async ({ args: { triggerId }, ctx }) => {
        if (await ctx.db.get(triggerId)) {
            return null;
        }

        if (await deleteDeliveries(ctx, triggerId, DELIVERY_PURGE_BATCH)) {
            await ctx.scheduler.runAfter(0, internal.triggers.deliveries.purgeDeliveries, { triggerId });
        }

        return null;
    });

/** What `deleteTrigger` calls once the trigger row is gone: one batch now, the rest on the scheduler. */
export const deleteDeliveriesOfTrigger = async (ctx: MutationCtx, triggerId: Id<"triggers">): Promise<void> => {
    if (await deleteDeliveries(ctx, triggerId, DELIVERY_PURGE_BATCH)) {
        await ctx.scheduler.runAfter(0, internal.triggers.deliveries.purgeDeliveries, { triggerId });
    }
};
