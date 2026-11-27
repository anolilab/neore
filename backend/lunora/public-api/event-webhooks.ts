/**
 * The Events webhook subscription store (`eventWebhookSubscriptions`), on the owner's shard. One row per subscription key. The
 * internal functions here are what the router calls; the plain functions are what the tests drive, with an explicit `now`.
 *
 * A subscription holds a `scanSeq`: the last log position it has been scanned to. Part 2a scans nothing, so the position is
 * where the subscription started; part 2b's sweep moves it, and the cursor the client persists is derived from it.
 */
import { v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { isHostApproved } from "../auth/event-webhook-hosts";
import { isErasing } from "../lib/account-moves";
import { MAX_SUBSCRIPTIONS } from "./events-webhook";

/** Expired rows reclaimed per sweep call. The sweep runs again on the next tick while it reports more. */
const REAP_BATCH = 200;

export interface SubscribeWrite {
    argumentsKey: string;
    /** The decoded cursor: the position replay starts after. `null` is "start from now". */
    cursorSeq: number | null;
    grantedTtlMs: number;
    host: string;
    id: string;
    keyHash: string;
    maxAgeMs: number | null;
    name: string;
    principal: string;
    secretCiphertext: string;
    url: string;
    userId: string;
}

export type SubscribeOutcome =
    | { cursorSeq: number; expiresAt: number; kind: "granted"; truncated: boolean }
    | { kind: "account_erasing" }
    | { kind: "host_not_approved" }
    | { kind: "limit" };

/**
 * The mutation's answer on the wire: a flat object, with `refusal` set exactly when nothing was granted (the numbers are then 0).
 * A union of objects is typed `unknown` by the generated client, so the outcome is flattened here and rebuilt by the caller.
 */
const vSubscribeWire = v.object({
    cursorSeq: v.number(),
    expiresAt: v.number(),
    refusal: v.union(v.null(), v.literal("account_erasing"), v.literal("host_not_approved"), v.literal("limit")),
    truncated: v.boolean(),
});

const toWire = (outcome: SubscribeOutcome) =>
    outcome.kind === "granted"
        ? { cursorSeq: outcome.cursorSeq, expiresAt: outcome.expiresAt, refusal: null, truncated: outcome.truncated }
        : { cursorSeq: 0, expiresAt: 0, refusal: outcome.kind, truncated: false };

/**
 * The seq of the oldest row the owner's log still keeps, or `undefined` when it keeps none. The newest seq is the watermark's
 * (`mcpEventWatermarks`), never a row's: retention may delete the newest rows.
 */
const oldestSeqOf = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<number | undefined> => {
    const row = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: "asc" }], where: { userId } });

    return row?.seq;
};

/**
 * Creates the subscription, or refreshes it when a live one has the same key.
 *
 * A live refresh resets the TTL and replaces the secret, and its cursor is a no-op: the spec's "at or behind" rule, since the
 * subscription already has a position. An absent or expired key starts fresh at the supplied cursor, or at the log's end.
 * `truncated` is set when the cursor is older than the log keeps (the position then moves to the oldest event still held).
 */
export const subscribeOn = async (ctx: Pick<MutationCtx, "db">, input: SubscribeWrite, now: number): Promise<SubscribeOutcome> => {
    // The erasure's final drain of subscriptions runs after its marker is set, so a row written once the marker is there would survive it.
    if (await isErasing(ctx, input.userId)) {
        return { kind: "account_erasing" };
    }

    if (!(await isHostApproved(ctx, input.userId, input.host))) {
        return { kind: "host_not_approved" };
    }

    const existing = await ctx.db.eventWebhookSubscriptions.findFirst({ where: { keyHash: input.keyHash, userId: input.userId } });
    const expiresAt = now + input.grantedTtlMs;

    if (existing && existing.expiresAt > now) {
        await ctx.db.patch("eventWebhookSubscriptions", existing._id, { expiresAt, secretCiphertext: input.secretCiphertext, updatedAt: now });

        return { cursorSeq: existing.scanSeq, expiresAt, kind: "granted", truncated: false };
    }

    if (!existing) {
        const { page } = await ctx.db.eventWebhookSubscriptions.findMany({ limit: MAX_SUBSCRIPTIONS, where: { userId: input.userId } });

        // Expired rows hold a slot until the sweep reaps them, so this account's own are reaped here and do not count against the cap.
        const expired = page.filter((row) => row.expiresAt <= now);

        for (const row of expired) {
            await ctx.db.delete("eventWebhookSubscriptions", row._id);
        }

        if (page.length - expired.length >= MAX_SUBSCRIPTIONS) {
            return { kind: "limit" };
        }
    }

    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId: input.userId } });
    const latestSeq = watermark?.seq ?? 0;
    const oldestSeq = await oldestSeqOf(ctx, input.userId);
    let scanSeq = latestSeq;
    let truncated = false;

    if (input.cursorSeq !== null) {
        scanSeq = Math.min(input.cursorSeq, latestSeq);

        // An empty log holds nothing, so its oldest position is the one after its end (as `events/poll` reads it): a cursor
        // behind that has been skipped past.
        const oldest = oldestSeq ?? latestSeq + 1;

        if (scanSeq + 1 < oldest) {
            scanSeq = oldest - 1;
            truncated = true;
        }
    }

    const fields = {
        argumentsKey: input.argumentsKey,
        expiresAt,
        id: input.id,
        keyHash: input.keyHash,
        // Zero is "no floor": the spec ignores maxAgeMs when there is no cursor.
        minTimestamp: input.cursorSeq !== null && input.maxAgeMs !== null ? now - input.maxAgeMs : 0,
        name: input.name,
        principal: input.principal,
        scanSeq,
        secretCiphertext: input.secretCiphertext,
        updatedAt: now,
        url: input.url,
    };

    if (existing) {
        await ctx.db.patch("eventWebhookSubscriptions", existing._id, fields);
    } else {
        await ctx.db.insert("eventWebhookSubscriptions", { ...fields, createdAt: now, userId: input.userId });
    }

    return { cursorSeq: scanSeq, expiresAt, kind: "granted", truncated };
};

/** Ends the subscription with this key. An expired row is removed too, but it is not a subscription that was there to end. */
export const unsubscribeOn = async (ctx: Pick<MutationCtx, "db">, userId: string, keyHash: string, now: number): Promise<boolean> => {
    const row = await ctx.db.eventWebhookSubscriptions.findFirst({ where: { keyHash, userId } });

    if (!row) {
        return false;
    }

    await ctx.db.delete("eventWebhookSubscriptions", row._id);

    return row.expiresAt > now;
};

/** Removes up to one batch of expired subscriptions. Each delete is its own call, in order. */
export const reapExpiredOn = async (ctx: Pick<MutationCtx, "db">, now: number): Promise<{ hasMore: boolean; removed: number }> => {
    const { page } = await ctx.db.eventWebhookSubscriptions.findMany({ limit: REAP_BATCH, where: { expiresAt: { lt: now } } });

    for (const row of page) {
        await ctx.db.delete("eventWebhookSubscriptions", row._id);
    }

    return { hasMore: page.length === REAP_BATCH, removed: page.length };
};

export const subscribe = internalMutation
    .input({
        argumentsKey: v.string(),
        // Optional rather than nullable: the generated client types a nullable union as `unknown`. Absent means null.
        cursorSeq: v.optional(v.number()),
        grantedTtlMs: v.number(),
        host: v.string(),
        id: v.string(),
        keyHash: v.string(),
        maxAgeMs: v.optional(v.number()),
        name: v.string(),
        principal: v.string(),
        secretCiphertext: v.string(),
        url: v.string(),
        userId: v.string(),
    })
    .output(vSubscribeWire)
    .mutation(async ({ args, ctx }) =>
        toWire(await subscribeOn(ctx, { ...args, cursorSeq: args.cursorSeq ?? null, maxAgeMs: args.maxAgeMs ?? null }, ctx.now)),
    );

export const unsubscribe = internalMutation
    .input({ keyHash: v.string(), userId: v.string() })
    .output(v.object({ found: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        return { found: await unsubscribeOn(ctx, args.userId, args.keyHash, ctx.now) };
    });

/** The shard sweep: reclaims expired subscriptions (`lib/shard-housekeeping.ts`). */
export const reapExpiredEventSubscriptions = internalMutation
    .output(v.object({ hasMore: v.boolean(), removed: v.number() }))
    .mutation(async ({ ctx }) => await reapExpiredOn(ctx, ctx.now));
