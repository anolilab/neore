/**
 * The Events webhook delivery queue against the real schema: the sweep queues matching events and gaps, the claim returns the
 * watermark, a failed attempt is retried a bounded number of times, a refused one is not retried, a removed host ends its
 * subscription, an expired subscription sends nothing, and unsubscribe clears what was queued.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { subscribeOn, type SubscribeWrite, unsubscribeOn } from "./event-webhooks";
import { BACKOFF_MS, claimOn, dispatchOn, LEASE_MS, MAX_ATTEMPTS, recordAttemptOn } from "./event-webhook-deliveries";

const OWNER = "owner-user";
const HOST = "hooks.example.com";
const CALLBACK_URL = `https://${HOST}/neore`;
const NOW = 1_000_000_000;
const MESSAGE_ID = /^msg_[\da-f]{32}$/;
const TTL = 60 * 60 * 1000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

const approve = async () => await harness.run(async (ctx: any) => await ctx.db.insert("eventWebhookHosts", { createdAt: NOW, host: HOST, userId: OWNER }));

interface SeedEvent {
    name?: string;
    seq: number;
    threadId?: string;
    timestamp?: number;
}

const seed = async (events: SeedEvent[]) =>
    await harness.run(async (ctx: any) => {
        for (const event of events) {
            await ctx.db.insert("mcpEvents", {
                createdAt: NOW,
                data: JSON.stringify(event.threadId === undefined ? {} : { threadId: event.threadId }),
                eventId: `evt-${event.seq}`,
                name: event.name ?? "run.completed",
                seq: event.seq,
                timestamp: event.timestamp ?? NOW,
                userId: OWNER,
            });
        }
    });

const prune = async (seqs: number[]) =>
    await harness.run(async (ctx: any) => {
        for (const seq of seqs) {
            const row = await ctx.db.mcpEvents.findFirst({ where: { seq, userId: OWNER } });

            await ctx.db.delete("mcpEvents", row._id);
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
        recordVerification: false,
        secretCiphertext: "ciphertext-1",
        url: CALLBACK_URL,
        userId: OWNER,
        ...overrides,
    };
};

const subscribe = async (input: SubscribeWrite, now = NOW) => await harness.run(async (ctx: any) => await subscribeOn(ctx, input, now));

const deliveries = async () =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.eventWebhookDeliveries.findMany({ where: { userId: OWNER } });

        return page;
    });

const deliveryAt = async (seq: number) => {
    const rows = await deliveries();

    return rows.find((row: { seq: number }) => row.seq === seq);
};

const seqsOf = async (): Promise<number[]> => {
    const rows = await deliveries();

    return rows.map((row: { seq: number }) => row.seq).toSorted((a: number, b: number) => a - b);
};

const idAt = async (seq: number): Promise<Id<"eventWebhookDeliveries">> => {
    const row = await deliveryAt(seq);

    return row._id;
};

const effects = () => {
    return {
        deliver: vi.fn(async (_deliveryId: unknown, _userId: unknown) => undefined),
        terminate: vi.fn(async (_input: unknown) => undefined),
    };
};

const sweep = async (now: number, effect = effects()) => {
    return {
        effect,
        outcome: await harness.run(async (ctx: any) => await dispatchOn(ctx, now, effect as never)),
    };
};

const claim = async (id: Id<"eventWebhookDeliveries">, now: number) => await harness.run(async (ctx: any) => await claimOn(ctx, id, now));

const record = async (id: Id<"eventWebhookDeliveries">, outcome: { category: string; kind: string }, now: number) =>
    await harness.run(async (ctx: any) => await recordAttemptOn(ctx, id, outcome, now));

describe("the sweep", () => {
    it("queues a delivery for each matching event and no other", async () => {
        await approve();
        await seed([{ seq: 1 }, { name: "run.failed", seq: 2 }, { seq: 3 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));

        const { effect, outcome } = await sweep(NOW);

        expect(outcome).toStrictEqual({ queued: 2 });
        expect(await seqsOf()).toStrictEqual([1, 3]);
        expect(effect.deliver).toHaveBeenCalledTimes(2);
    });

    it("matches a threadId argument on the event's own thread", async () => {
        await approve();
        await seed([{ seq: 1 }, { seq: 2, threadId: "t1" }, { seq: 3, threadId: "t2" }]);
        await subscribe(writeOf({ argumentsKey: '{"threadId":"t1"}', cursorSeq: 0, id: "sub_2", keyHash: "hash-2" }));

        await sweep(NOW);

        expect(await seqsOf()).toStrictEqual([2]);
    });

    it("queues a gap where retention has pruned events, then the events after it", async () => {
        await approve();
        await seed([{ seq: 1 }, { seq: 2 }]);
        await subscribe(writeOf());
        await prune([1, 2]);
        await seed([{ seq: 5 }]);

        await sweep(NOW);

        const rows = await deliveries();

        expect(
            rows.map((row: { kind: string; seq: number }) => [row.kind, row.seq]).toSorted((a: [string, number], b: [string, number]) => a[1] - b[1]),
        ).toStrictEqual([
            ["gap", 4],
            ["event", 5],
        ]);
    });

    it("sends each queued delivery once within its lease", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));

        const first = await sweep(NOW);
        const second = await sweep(NOW + 1000, first.effect);

        // One spy is shared by both sweeps, so the count is cumulative: the second sweep queued nothing.
        expect(first.effect.deliver).toHaveBeenCalledTimes(1);
        expect(second.effect.deliver).toHaveBeenCalledTimes(1);
        expect(LEASE_MS).toBeGreaterThan(10_000);
    });

    it("ends a subscription whose host left the allowlist, drops its deliveries, and sends the terminated notice", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.eventWebhookHosts.findFirst({ where: { host: HOST, userId: OWNER } });

            await ctx.db.delete("eventWebhookHosts", row._id);
        });

        const { effect } = await sweep(NOW + 1000);

        expect(effect.terminate).toHaveBeenCalledWith(expect.objectContaining({ url: CALLBACK_URL, userId: OWNER }));
        expect(await deliveries()).toHaveLength(0);
    });
});

describe("the claim", () => {
    it("returns the watermark: the scan position held back below the lowest pending delivery", async () => {
        await approve();
        await seed([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);

        const work = await claim(await idAt(2), NOW);

        expect(work).toMatchObject({ attempt: 1, cursorSeq: 0, kind: "event", name: "run.completed" });
        expect(work?.webhookId).toMatch(MESSAGE_ID);
    });

    it("does nothing for a delivery that already settled", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);
        const id = await idAt(1);

        await claim(id, NOW);
        await record(id, { category: "", kind: "delivered" }, NOW);

        expect(await claim(id, NOW)).toBeNull();
    });

    it("settles a delivery whose subscription has expired, sending nothing", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);
        const id = await idAt(1);

        expect(await claim(id, NOW + TTL + 1)).toBeNull();
        expect(await deliveryAt(1)).toMatchObject({ lastError: "subscription_ended", status: "abandoned" });
    });
});

describe("retries", () => {
    it("retries a failed attempt on the backoff, and abandons it once its attempts are used", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);
        const id = await idAt(1);
        let now = NOW;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const work = await claim(id, now);

            expect(work?.attempt).toBe(attempt);
            await record(id, { category: "http_5xx", kind: "failed" }, now);
            now += BACKOFF_MS[attempt - 1] ?? 0;
        }

        expect(await deliveryAt(1)).toMatchObject({ attempts: MAX_ATTEMPTS, lastError: "http_5xx", status: "abandoned" });
        expect(await claim(await idAt(1), now)).toBeNull();
    });

    it("waits the first backoff after a failure, and does not retry a refused answer", async () => {
        await approve();
        await seed([{ seq: 1 }, { seq: 2 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);

        const first = await idAt(1);

        await claim(first, NOW);
        await record(first, { category: "http_5xx", kind: "failed" }, NOW);

        expect(await deliveryAt(1)).toMatchObject({ nextAttemptAt: NOW + (BACKOFF_MS[0] ?? 0), status: "pending" });

        const second = await idAt(2);

        await claim(second, NOW);
        await record(second, { category: "gone", kind: "refused" }, NOW);

        expect(await deliveryAt(2)).toMatchObject({ attempts: 1, lastError: "gone", status: "abandoned" });
    });
});

describe("ending a subscription", () => {
    it("unsubscribe clears what was queued for it", async () => {
        await approve();
        await seed([{ seq: 1 }]);
        await subscribe(writeOf({ cursorSeq: 0 }));
        await sweep(NOW);

        expect(await harness.run(async (ctx: any) => await unsubscribeOn(ctx, OWNER, "hash-1", NOW))).toBe(true);
        expect(await deliveries()).toHaveLength(0);
    });
});
