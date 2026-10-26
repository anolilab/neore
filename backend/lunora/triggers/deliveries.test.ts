/**
 * The permanent delivery record of a `gitlab-token` trigger: one winner per
 * (delivery id, body), given back only through its row id, gone with the trigger.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { claimWebhookDelivery, DELIVERY_PURGE_BATCH, purgeDeliveries, releaseWebhookDelivery } from "./deliveries";
import { admitTriggerRun } from "./functions";
import { eraseTriggersForUser } from "./gdpr";
import { BATCH } from "../gdpr/batch";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const DIGEST = "d".repeat(64);

const insertTrigger = async (userId = "u", filters?: unknown[]): Promise<string> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("triggers", {
                createdAt: 1,
                enabled: true,
                filters,
                model: "m",
                name: "t",
                triggerCount: 0,
                type: "webhook",
                updatedAt: 1,
                userId,
            }),
    );

const claim = async (triggerId: string, deliveryId = "evt-1", bodyDigest = DIGEST): Promise<string | null> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(claimWebhookDelivery, { bodyDigest, deliveryId, triggerId }));

const insertRecords = async (triggerId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let n = 0; n < count; n += 1) {
            await ctx.db.insert("webhookDeliveries", { bodyDigest: DIGEST, createdAt: 1, deliveryId: `evt-${String(n)}`, triggerId });
        }
    });
};

const recordCount = async (triggerId?: string): Promise<number> => {
    const rows = (await harness.run(async (ctx: any) => await ctx.db.query("webhookDeliveries").collect())) as { triggerId: string }[];

    return rows.filter((row) => triggerId === undefined || row.triggerId === triggerId).length;
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("claimWebhookDelivery", () => {
    it("has one winner when the same delivery arrives concurrently", async () => {
        const triggerId = await insertTrigger();
        const results = await Promise.all(Array.from({ length: 8 }, async () => await claim(triggerId)));

        expect(results.filter((id) => id !== null)).toHaveLength(1);
        expect(await recordCount()).toBe(1);
    });

    it("keeps the pair per trigger: another id, another body and another trigger each claim afresh", async () => {
        const first = await insertTrigger();
        const second = await insertTrigger();

        expect(await claim(first)).not.toBeNull();
        expect(await claim(first)).toBeNull();
        expect(await claim(first, "evt-2")).not.toBeNull();
        expect(await claim(first, "evt-1", "e".repeat(64))).not.toBeNull();
        expect(await claim(second)).not.toBeNull();
    });

    it("refuses to record a delivery for a trigger that no longer exists", async () => {
        const triggerId = await insertTrigger();

        await harness.run(async (ctx: any) => await ctx.db.delete(triggerId));

        await expect(claim(triggerId)).rejects.toThrow("Trigger not found");
        expect(await recordCount()).toBe(0);
    });
});

describe("giving a record back", () => {
    it("lets the delivery be claimed again, and a late release leaves the replacement alone", async () => {
        const triggerId = await insertTrigger();
        const original = (await claim(triggerId))!;
        const release = async (recordId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(releaseWebhookDelivery, { recordId }));

        await release(original);
        expect(await recordCount()).toBe(0);

        const replacement = await claim(triggerId);

        expect(replacement).not.toBeNull();

        await release(original);
        expect(await recordCount()).toBe(1);
    });

    it("admission gives it back when the filters saved since no longer match the delivery", async () => {
        const triggerId = await insertTrigger("u", [{ op: "equals", path: "object_kind", value: "push" }]);
        const deliveryRecord = (await claim(triggerId))!;
        const refusal = await harness.run(
            async (ctx: any) => await ctx.runMutation(admitTriggerRun, { deliveryRecord, filterPayload: '{"object_kind":"note"}', triggerId }),
        );

        expect(refusal).toMatchObject({ filtered: expect.any(String) });
        expect(await recordCount()).toBe(0);
    });
});

describe("the record's lifetime", () => {
    it("is cleared by erasure along with the trigger, in as many rounds as it takes", async () => {
        const triggerId = await insertTrigger("erased");
        const kept = await insertTrigger("kept");

        await insertRecords(triggerId, BATCH + 3);
        await insertRecords(kept, 2);

        const rounds: boolean[] = [];

        for (let round = 0; round < 5; round += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await eraseTriggersForUser(ctx, "erased"));

            rounds.push(hasMore);

            if (!hasMore) {
                break;
            }
        }

        expect(rounds.at(-1)).toBe(false);
        expect(rounds.length).toBeGreaterThan(1);
        expect(await recordCount(triggerId)).toBe(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.get(triggerId))).toBeNull();
        expect(await recordCount(kept)).toBe(2);
    });

    it("keeps the trigger until its records are gone", async () => {
        const triggerId = await insertTrigger("erased");

        await insertRecords(triggerId, BATCH + 1);

        const { hasMore } = await harness.run(async (ctx: any) => await eraseTriggersForUser(ctx, "erased"));

        expect(hasMore).toBe(true);
        expect(await harness.run(async (ctx: any) => await ctx.db.get(triggerId))).not.toBeNull();
    });

    it("purgeDeliveries clears a deleted trigger's records batch by batch and never a live trigger's", async () => {
        const live = await insertTrigger();
        const gone = await insertTrigger();

        await insertRecords(live, 2);
        await insertRecords(gone, DELIVERY_PURGE_BATCH + 5);
        await harness.run(async (ctx: any) => await ctx.db.delete(gone));

        await harness.run(async (ctx: any) => await ctx.runMutation(purgeDeliveries, { triggerId: live }));
        expect(await recordCount(live)).toBe(2);

        await harness.run(async (ctx: any) => await ctx.runMutation(purgeDeliveries, { triggerId: gone }));
        expect(await recordCount(gone)).toBe(5);
        expect(harness.scheduler.list()).toHaveLength(1);

        await harness.run(async (ctx: any) => await ctx.runMutation(purgeDeliveries, { triggerId: gone }));
        expect(await recordCount(gone)).toBe(0);
        expect(harness.scheduler.list()).toHaveLength(1);
    });
});
