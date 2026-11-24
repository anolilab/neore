/**
 * The Events webhook delivery queue (`eventWebhookDeliveries`, part 2b), on the owner's shard. One row per (subscription, log
 * position) that matched, plus one `gap` row where retention skipped events. The shard sweep scans each live subscription's log
 * forward and queues the rows; a queued row is sent by `events-webhook-send.ts`, which claims it here and records the outcome here.
 *
 * Retries (SEP-3415, "Delivery model"): at most `MAX_ATTEMPTS` attempts, and no retry past `RETRY_WINDOW_MS` from the first. A
 * `410`, a `413` or a redirect is refused and never retried. Each attempt keeps the `webhook-id` and regenerates the timestamp
 * and the signature (that happens in the wire module, per attempt).
 *
 * The watermark (SEP-3415, "webhook event delivery"): the cursor a delivery carries is the position at or before which every event
 * is delivered or abandoned. It is the subscription's scan position, held back to just below its lowest pending delivery.
 */
import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isHostApproved } from "../auth/event-webhook-hosts";
import { enqueueJob } from "../lib/job-queue";
import { MAX_SUBSCRIPTIONS, subscriptionIdOf } from "./events-webhook";
import { messageIdOf } from "./events-webhook-wire";

export const MAX_ATTEMPTS = 4;
/** The wait after failed attempts 1, 2 and 3. */
export const BACKOFF_MS = [60_000, 180_000, 420_000];
export const RETRY_WINDOW_MS = 15 * 60 * 1000;
/** A claimed delivery's lease: the sweep and the sender both leave it alone until it lapses. Longer than one attempt's deadline. */
export const LEASE_MS = 2 * 60 * 1000;

const SCAN_BATCH = 100;
const DUE_BATCH = 50;
const PENDING_BATCH = 500;

type Db = Pick<MutationCtx, "db">;

/** What a send needs, read on the claim. `data` is the event's payload as JSON text, `{}` for a gap. */
export const vDeliveryWork = v.object({
    attempt: v.number(),
    cursorSeq: v.number(),
    data: v.string(),
    eventId: v.string(),
    kind: v.string(),
    name: v.string(),
    secretCiphertext: v.string(),
    subscriptionId: v.string(),
    timestamp: v.number(),
    url: v.string(),
    userId: v.string(),
    webhookId: v.string(),
});

export type DeliveryWork = Infer<typeof vDeliveryWork>;

export const vOutcome = v.object({ category: v.string(), kind: v.string() });

/**
 * The position after which an empty or pruned log resumes: the seq of its oldest kept row, or, when it keeps none, the one after
 * the watermark (the same rule `events/poll` and `events/subscribe` use). The newest seq is the watermark's, never a row's.
 */
const oldestPositionOf = async (ctx: Db, userId: string): Promise<number> => {
    const row = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: "asc" }], where: { userId } });

    if (row) {
        return row.seq;
    }

    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId } });

    return (watermark?.seq ?? 0) + 1;
};

/** The cursor position for a subscription: its scan position, held back below its lowest pending delivery. */
export const watermarkFor = async (ctx: Db, userId: string, keyHash: string, scanSeq: number): Promise<number> => {
    const { page } = await ctx.db.eventWebhookDeliveries.findMany({ limit: PENDING_BATCH, where: { keyHash, userId } });
    let lowest: number | undefined;

    for (const row of page) {
        if (row.status === "pending" && (lowest === undefined || row.seq < lowest)) {
            lowest = row.seq;
        }
    }

    return lowest === undefined ? scanSeq : Math.min(scanSeq, lowest - 1);
};

/** Erases a subscription's deliveries (unsubscribe, expiry, a removed host). */
export const deleteDeliveriesOf = async (ctx: Db, userId: string, keyHash: string): Promise<void> => {
    const { page } = await ctx.db.eventWebhookDeliveries.findMany({ limit: PENDING_BATCH, where: { keyHash, userId } });

    for (const row of page) {
        await ctx.db.delete("eventWebhookDeliveries", row._id);
    }
};

const matchesArguments = (argumentsKey: string, data: string): boolean => {
    if (argumentsKey === "{}") {
        return true;
    }

    const { threadId } = JSON.parse(argumentsKey) as { threadId?: unknown };

    return (JSON.parse(data) as { threadId?: unknown }).threadId === threadId;
};

interface QueueInput {
    eventId: string;
    keyHash: string;
    kind: "event" | "gap";
    name: string;
    seq: number;
    timestamp: number;
    userId: string;
}

const insertDelivery = async (ctx: Db, input: QueueInput, now: number): Promise<void> => {
    await ctx.db.insert("eventWebhookDeliveries", {
        attempts: 0,
        createdAt: now,
        eventId: input.eventId,
        firstAttemptAt: 0,
        keyHash: input.keyHash,
        kind: input.kind,
        lastError: "",
        leaseUntil: 0,
        name: input.name,
        nextAttemptAt: now,
        seq: input.seq,
        status: "pending",
        timestamp: input.timestamp,
        updatedAt: now,
        userId: input.userId,
        webhookId: messageIdOf(),
    });
};

const finish = async (ctx: Db, row: { _id: Id<"eventWebhookDeliveries"> }, status: string, lastError: string, now: number): Promise<void> => {
    await ctx.db.patch("eventWebhookDeliveries", row._id, { lastError, leaseUntil: 0, status, updatedAt: now });
};

/**
 * Claims one queued delivery for an attempt: returns what the send needs, or `null` when there is nothing to send (already
 * settled, or its subscription has ended or lost its host, which settles it here).
 */
export const claimOn = async (ctx: Db, deliveryId: Id<"eventWebhookDeliveries">, now: number): Promise<DeliveryWork | null> => {
    const row = await ctx.db.get("eventWebhookDeliveries", deliveryId);

    if (!row || row.status !== "pending") {
        return null;
    }

    const sub = await ctx.db.eventWebhookSubscriptions.findFirst({ where: { keyHash: row.keyHash, userId: row.userId } });

    if (!sub || sub.expiresAt <= now) {
        await finish(ctx, row, "abandoned", "subscription_ended", now);

        return null;
    }

    if (!(await isHostApproved(ctx, row.userId, new URL(sub.url).hostname))) {
        await finish(ctx, row, "abandoned", "host_not_approved", now);

        return null;
    }

    let data = "{}";

    if (row.kind === "event") {
        const event = await ctx.db.mcpEvents.findFirst({ where: { seq: row.seq, userId: row.userId } });

        if (!event) {
            await finish(ctx, row, "abandoned", "event_pruned", now);

            return null;
        }

        data = event.data;
    }

    const cursorSeq = row.kind === "gap" ? row.seq : await watermarkFor(ctx, row.userId, row.keyHash, sub.scanSeq);

    await ctx.db.patch("eventWebhookDeliveries", row._id, {
        attempts: row.attempts + 1,
        firstAttemptAt: row.firstAttemptAt === 0 ? now : row.firstAttemptAt,
        leaseUntil: now + LEASE_MS,
        updatedAt: now,
    });

    return {
        attempt: row.attempts + 1,
        cursorSeq,
        data,
        eventId: row.eventId,
        kind: row.kind,
        name: row.name,
        secretCiphertext: sub.secretCiphertext,
        subscriptionId: subscriptionIdOf(row.keyHash),
        timestamp: row.timestamp,
        url: sub.url,
        userId: row.userId,
        webhookId: row.webhookId,
    };
};

/**
 * Records one attempt's outcome. A delivered or refused row settles. A failed row is retried after its backoff, unless it has used
 * its attempts or the next try would fall past the retry window, in which case it is abandoned.
 */
export const recordAttemptOn = async (
    ctx: Db,
    deliveryId: Id<"eventWebhookDeliveries">,
    outcome: { category: string; kind: string },
    now: number,
): Promise<void> => {
    const row = await ctx.db.get("eventWebhookDeliveries", deliveryId);

    if (!row || row.status !== "pending") {
        return;
    }

    if (outcome.kind === "delivered") {
        await finish(ctx, row, "delivered", "", now);

        return;
    }

    if (outcome.kind === "refused") {
        await finish(ctx, row, "abandoned", outcome.category, now);

        return;
    }

    const backoff = BACKOFF_MS[Math.min(row.attempts - 1, BACKOFF_MS.length - 1)] ?? 0;
    const retryAt = now + backoff;

    if (row.attempts >= MAX_ATTEMPTS || retryAt - row.firstAttemptAt > RETRY_WINDOW_MS) {
        await finish(ctx, row, "abandoned", outcome.category, now);

        return;
    }

    await ctx.db.patch("eventWebhookDeliveries", row._id, { lastError: outcome.category, leaseUntil: 0, nextAttemptAt: retryAt, updatedAt: now });
};

/** The effects a sweep asks for: a send of one queued delivery, or the terminated notice for a removed host. */
export interface DispatchEffects {
    deliver: (deliveryId: Id<"eventWebhookDeliveries">, userId: string) => Promise<void>;
    terminate: (input: { secretCiphertext: string; subscriptionId: string; url: string; userId: string }) => Promise<void>;
}

/**
 * Scans each live subscription's log forward from its position, queues a delivery for each match (and a gap row where retention
 * skipped events), then queues the due deliveries. A subscription whose host has left the allowlist is ended here, its
 * deliveries with it, and its `terminated` notice is queued.
 */
export const dispatchOn = async (ctx: Db, now: number, effects: DispatchEffects): Promise<{ queued: number }> => {
    const { page: subs } = await ctx.db.eventWebhookSubscriptions.findMany({ limit: MAX_SUBSCRIPTIONS, where: { expiresAt: { gt: now } } });

    for (const sub of subs) {
        if (!(await isHostApproved(ctx, sub.userId, new URL(sub.url).hostname))) {
            await deleteDeliveriesOf(ctx, sub.userId, sub.keyHash);
            await ctx.db.delete("eventWebhookSubscriptions", sub._id);
            await effects.terminate({
                secretCiphertext: sub.secretCiphertext,
                subscriptionId: subscriptionIdOf(sub.keyHash),
                url: sub.url,
                userId: sub.userId,
            });

            continue;
        }

        let { scanSeq } = sub;
        const oldest = await oldestPositionOf(ctx, sub.userId);

        if (scanSeq + 1 < oldest) {
            await insertDelivery(ctx, { eventId: "", keyHash: sub.keyHash, kind: "gap", name: "", seq: oldest - 1, timestamp: 0, userId: sub.userId }, now);
            scanSeq = oldest - 1;
        }

        const { page: rows } = await ctx.db.mcpEvents.findMany({
            limit: SCAN_BATCH,
            orderBy: [{ seq: "asc" }],
            where: { seq: { gt: scanSeq }, userId: sub.userId },
        });

        for (const row of rows) {
            scanSeq = row.seq;

            if (row.timestamp >= sub.minTimestamp && row.name === sub.name && matchesArguments(sub.argumentsKey, row.data)) {
                await insertDelivery(
                    ctx,
                    { eventId: row.eventId, keyHash: sub.keyHash, kind: "event", name: row.name, seq: row.seq, timestamp: row.timestamp, userId: sub.userId },
                    now,
                );
            }
        }

        if (scanSeq !== sub.scanSeq) {
            await ctx.db.patch("eventWebhookSubscriptions", sub._id, { scanSeq, updatedAt: now });
        }
    }

    const { page: due } = await ctx.db.eventWebhookDeliveries.findMany({ limit: DUE_BATCH, where: { nextAttemptAt: { lte: now }, status: "pending" } });
    let queued = 0;

    for (const row of due) {
        if (row.leaseUntil > now) {
            continue;
        }

        await ctx.db.patch("eventWebhookDeliveries", row._id, { leaseUntil: now + LEASE_MS, updatedAt: now });
        await effects.deliver(row._id, row.userId);
        queued += 1;
    }

    return { queued };
};

export const claimDelivery = internalMutation
    .input({ deliveryId: v.id("eventWebhookDeliveries") })
    .output(v.union(v.null(), vDeliveryWork))
    .mutation(async ({ args, ctx }) => await claimOn(ctx, args.deliveryId, ctx.now));

export const recordAttempt = internalMutation
    .input({ deliveryId: v.id("eventWebhookDeliveries"), outcome: vOutcome })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await recordAttemptOn(ctx, args.deliveryId, args.outcome, ctx.now);

        return null;
    });

/** The shard sweep (`lib/shard-housekeeping.ts`): queues matches and due sends, and ends subscriptions whose host was removed. */
export const dispatchEventWebhooks = internalMutation.output(v.object({ queued: v.number() })).mutation(
    async ({ ctx }) =>
        await dispatchOn(ctx, ctx.now, {
            deliver: async (deliveryId, userId) => {
                await enqueueJob(internal.public_api.events_webhook_send.sendDelivery, { deliveryId }, { shardKey: userId });
            },
            terminate: async (input) => {
                await enqueueJob(internal.public_api.events_webhook_send.sendTerminated, input, { shardKey: input.userId });
            },
        }),
);
