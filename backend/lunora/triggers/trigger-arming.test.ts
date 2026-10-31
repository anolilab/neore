/**
 * Schedule arming, pinned against the real index:
 *
 * - the shard tick reads the earliest ARMED schedule trigger, and a webhook
 *   trigger (which never has a `nextTriggerAt`) never comes back in its place;
 * - enabling a schedule trigger that has never run arms its first run from the
 *   cron; enabling a webhook trigger does not.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { setTriggerEnabledInternal } from "./functions";

const { noteShardDue } = vi.hoisted(() => {
    return {
        noteShardDue: vi.fn(async () => undefined),
    };
});

vi.mock("../lib/shard-housekeeping", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-housekeeping")>()),
        noteShardDue,
    };
});

const NOW = 1_800_000_000_000;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    noteShardDue.mockClear();
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

const base = { createdAt: NOW, enabled: false, model: "m", name: "t", triggerCount: 0, updatedAt: NOW, userId: "user-a" };

const insertTrigger = async (row: Record<string, unknown>): Promise<string> =>
    await harness.run(async (ctx: any) => (await ctx.db.insert("triggers", { ...base, ...row })) as unknown as string);

/** The exact query `runShardTick` runs for its trigger candidate. */
const shardTickCandidate = async (): Promise<{ _id: string; type: string } | null> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("triggers")
                .withIndex("by_enabled_nextTriggerAt", (q: any) => q.eq("enabled", true).gt("nextTriggerAt", 0))
                .first(),
    );

describe("shard tick trigger candidate", () => {
    it("ignores an enabled webhook trigger, which has no nextTriggerAt", async () => {
        await insertTrigger({ enabled: true, type: "webhook" });

        await expect(shardTickCandidate()).resolves.toBeNull();
    });

    it("returns an armed event watcher: its next check is its nextTriggerAt", async () => {
        const watcherId = await insertTrigger({ enabled: true, nextTriggerAt: NOW + 500, type: "event" });

        await expect(shardTickCandidate()).resolves.toMatchObject({ _id: watcherId, type: "event" });
    });

    it("returns the armed schedule trigger even when a webhook trigger is also enabled", async () => {
        await insertTrigger({ enabled: true, type: "webhook" });
        const scheduleId = await insertTrigger({ cronExpression: "0 9 * * *", enabled: true, nextTriggerAt: NOW + 1000, type: "schedule" });

        await expect(shardTickCandidate()).resolves.toMatchObject({ _id: scheduleId, type: "schedule" });
    });
});

describe("enabling a trigger", () => {
    it("arms the first run of a schedule trigger that has never run", async () => {
        const id = await insertTrigger({ cronExpression: "0 9 * * *", enabled: false, type: "schedule" });

        await harness.run(async (ctx: any) => await ctx.runMutation(setTriggerEnabledInternal, { enabled: true, triggerId: id }));

        const row = await harness.run(async (ctx: any) => await ctx.db.get(id));

        expect(row.enabled).toBe(true);
        expect(row.nextTriggerAt).toBeGreaterThan(NOW);
        expect(noteShardDue).toHaveBeenCalledWith(expect.anything(), row.nextTriggerAt, "user-a");
    });

    it("leaves a webhook trigger without a nextTriggerAt", async () => {
        const id = await insertTrigger({ enabled: false, type: "webhook" });

        await harness.run(async (ctx: any) => await ctx.runMutation(setTriggerEnabledInternal, { enabled: true, triggerId: id }));

        const row = await harness.run(async (ctx: any) => await ctx.db.get(id));

        expect(row.enabled).toBe(true);
        expect(row.nextTriggerAt).toBeUndefined();
    });
});
