/**
 * The Events webhook store against the real schema: the subscription key and its idempotent upsert, the refresh and the cursor
 * rule, replay and truncation, expiry reclaim, the subscription cap, unsubscribe, and the per-account host allowlist.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { beginAccountMove } from "../lib/account-moves";
import schema from "../schema";
import { reapExpiredOn, type SubscribeWrite, subscribeOn, unsubscribeOn } from "./event-webhooks";
import { MAX_SUBSCRIPTIONS } from "./events-webhook";

const OWNER = "owner-user";
const HOST = "hooks.example.com";
const NOW = 1_000_000;
const TTL = 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

const approve = async (userId = OWNER, host = HOST) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("eventWebhookHosts", { createdAt: NOW, host, userId }));

/**
 * Log rows for the owner, one per seq, timestamped `timestamp`. The watermark moves to the highest seq seeded, as `recordMcpEvent`
 * would move it: the latest seq is the watermark's, never a row's.
 */
const seed = async (seqs: number[], timestamp = NOW) =>
    await harness.run(async (ctx: any) => {
        for (const seq of seqs) {
            await ctx.db.insert("mcpEvents", { createdAt: NOW, data: "{}", eventId: `evt-${seq}`, name: "run.completed", seq, timestamp, userId: OWNER });
        }

        const highest = Math.max(0, ...seqs);
        const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId: OWNER } });

        if (watermark) {
            if (highest > watermark.seq) {
                await ctx.db.patch("mcpEventWatermarks", watermark._id, { seq: highest });
            }
        } else {
            await ctx.db.insert("mcpEventWatermarks", { seq: highest, userId: OWNER });
        }
    });

const writeOf = (overrides: Partial<SubscribeWrite> = {}): SubscribeWrite => {
    return {
        argumentsKey: "{}",
        cursorSeq: null,
        grantedTtlMs: TTL,
        host: HOST,
        id: "sub_1",
        keyHash: "hash-1",
        maxAgeMs: null,
        name: "run.completed",
        principal: "key-1",
        secretCiphertext: "ciphertext-1",
        url: `https://${HOST}/neore`,
        userId: OWNER,
        ...overrides,
    };
};

const subscribe = async (input: SubscribeWrite, now = NOW) => await harness.run(async (ctx: any) => await subscribeOn(ctx, input, now));

const rows = async () =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.eventWebhookSubscriptions.findMany({ where: { userId: OWNER } });

        return page;
    });

describe("events/subscribe store", () => {
    it("refuses a host the owner has not approved, and stores nothing", async () => {
        await seed([1]);

        expect(await subscribe(writeOf())).toStrictEqual({ kind: "host_not_approved" });
        expect(await rows()).toHaveLength(0);
    });

    it("refuses a subscription once the account's erasure has begun, and stores nothing", async () => {
        await approve();
        await harness.run(async (ctx: any) => await beginAccountMove(ctx, OWNER, "erasing", NOW));

        expect(await subscribe(writeOf())).toStrictEqual({ kind: "account_erasing" });
        expect(await rows()).toHaveLength(0);
    });

    it("wakes the owner's shard at the subscription's expiry, so a dormant shard's expired rows are reaped", async () => {
        await approve();

        expect(await subscribe(writeOf())).toMatchObject({ kind: "granted" });

        const census = await harness.run(async (ctx: any) => await ctx.db.shardActivity.findFirst({ where: { shardKey: OWNER } }));

        expect(census?.nextDueAt).toBe(NOW + TTL + 1);
    });

    it("reaps the account's expired subscriptions at the cap, so they hold no slot", async () => {
        await approve();
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_SUBSCRIPTIONS; index += 1) {
                await ctx.db.insert("eventWebhookSubscriptions", {
                    argumentsKey: "{}",
                    createdAt: NOW,
                    expiresAt: NOW - 1,
                    id: `old_${index}`,
                    keyHash: `old-${index}`,
                    minTimestamp: 0,
                    name: "run.completed",
                    principal: "key-1",
                    scanSeq: 0,
                    secretCiphertext: "ciphertext",
                    updatedAt: NOW,
                    url: `https://${HOST}/${index}`,
                    userId: OWNER,
                });
            }
        });

        expect(await subscribe(writeOf({ keyHash: "fresh" }))).toMatchObject({ kind: "granted" });
        expect(await rows()).toHaveLength(1);
    });

    it("refuses a host approved by a different account: the allowlist is per account", async () => {
        await approve("someone-else");

        expect(await subscribe(writeOf())).toStrictEqual({ kind: "host_not_approved" });
    });

    it("starts at the log's end when the cursor is null, and grants the TTL from now", async () => {
        await approve();
        await seed([1, 2, 3]);

        expect(await subscribe(writeOf())).toStrictEqual({ cursorSeq: 3, expiresAt: NOW + TTL, kind: "granted", truncated: false });

        const [row] = await rows();

        expect(row).toMatchObject({ expiresAt: NOW + TTL, id: "sub_1", minTimestamp: 0, scanSeq: 3 });
    });

    it("is idempotent on the key: a second subscribe refreshes the TTL and the secret, and its cursor is a no-op", async () => {
        await approve();
        await seed([1, 2]);
        await subscribe(writeOf());
        await seed([3]);

        const again = await subscribe(writeOf({ cursorSeq: 1, secretCiphertext: "ciphertext-2" }), NOW + 10 * 60 * 1000);

        expect(again).toStrictEqual({ cursorSeq: 2, expiresAt: NOW + 10 * 60 * 1000 + TTL, kind: "granted", truncated: false });

        const stored = await rows();

        expect(stored).toHaveLength(1);
        expect(stored[0]).toMatchObject({ expiresAt: NOW + 10 * 60 * 1000 + TTL, secretCiphertext: "ciphertext-2" });
    });

    it("holds a different subscription for a different key: other arguments, or another principal", async () => {
        await approve();
        await subscribe(writeOf());
        await subscribe(writeOf({ argumentsKey: '{"threadId":"t1"}', id: "sub_2", keyHash: "hash-2" }));

        expect(await rows()).toHaveLength(2);
    });

    it("replays from a cursor the log still holds, and bounds the replay by maxAgeMs when there is a cursor", async () => {
        await approve();
        await seed([1, 2, 3]);

        expect(await subscribe(writeOf({ cursorSeq: 1, maxAgeMs: 5000 }))).toMatchObject({ cursorSeq: 1, kind: "granted", truncated: false });
        const [stored] = await rows();

        expect(stored).toMatchObject({ minTimestamp: NOW - 5000, scanSeq: 1 });
    });

    it("reports truncated, and starts at the oldest event the log still holds, when the cursor is older than that", async () => {
        await approve();
        await seed([5, 6]);

        expect(await subscribe(writeOf({ cursorSeq: 1 }))).toStrictEqual({ cursorSeq: 4, expiresAt: NOW + TTL, kind: "granted", truncated: true });
    });

    it("reclaims an expired subscription with the same key, starting fresh at the log's end", async () => {
        await approve();
        await seed([1]);
        await subscribe(writeOf());
        await seed([2]);

        const later = NOW + TTL + 1;
        const reclaimed = await subscribe(writeOf({ secretCiphertext: "ciphertext-3" }), later);

        expect(reclaimed).toStrictEqual({ cursorSeq: 2, expiresAt: later + TTL, kind: "granted", truncated: false });
        expect(await rows()).toHaveLength(1);
    });

    it("refuses a new subscription once the account holds the maximum", async () => {
        await approve();
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_SUBSCRIPTIONS; index += 1) {
                await ctx.db.insert("eventWebhookSubscriptions", {
                    argumentsKey: "{}",
                    createdAt: NOW,
                    expiresAt: NOW + TTL,
                    id: `sub_${index}`,
                    keyHash: `hash-${index}`,
                    minTimestamp: 0,
                    name: "run.completed",
                    principal: "key-1",
                    scanSeq: 0,
                    secretCiphertext: "ciphertext",
                    updatedAt: NOW,
                    url: `https://${HOST}/${index}`,
                    userId: OWNER,
                });
            }
        });

        expect(await subscribe(writeOf({ keyHash: "one-more" }))).toStrictEqual({ kind: "limit" });
    });
});

describe("events/unsubscribe store", () => {
    it("ends the subscription, and answers not found the second time", async () => {
        await approve();
        await subscribe(writeOf());

        expect(await harness.run(async (ctx: any) => await unsubscribeOn(ctx, OWNER, "hash-1", NOW))).toBe(true);
        expect(await rows()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await unsubscribeOn(ctx, OWNER, "hash-1", NOW))).toBe(false);
    });

    it("treats an expired subscription as absent, and removes it", async () => {
        await approve();
        await subscribe(writeOf());

        expect(await harness.run(async (ctx: any) => await unsubscribeOn(ctx, OWNER, "hash-1", NOW + TTL + 1))).toBe(false);
        expect(await rows()).toHaveLength(0);
    });
});

describe("the expiry sweep", () => {
    it("reclaims the expired subscriptions and keeps the live ones", async () => {
        await approve();
        await subscribe(writeOf());
        await subscribe(writeOf({ id: "sub_2", keyHash: "hash-2" }), NOW + TTL / 2);

        const outcome = await harness.run(async (ctx: any) => await reapExpiredOn(ctx, NOW + TTL + 1));

        expect(outcome).toStrictEqual({ hasMore: false, removed: 1 });
        const remaining = await rows();

        expect(remaining.map((row: { keyHash: string }) => row.keyHash)).toStrictEqual(["hash-2"]);
    });
});
