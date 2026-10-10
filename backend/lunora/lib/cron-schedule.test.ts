import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { claimDueCronJobs, PERIODIC_JOBS, runCronTick } from "../crons";
import { LUNORA_CRON_TRIGGERS, LUNORA_CRONS } from "../_generated/crons";
import schema from "../schema";
import type { PeriodicJob } from "./cron-schedule";
import { compareStrings } from "./collections";
import { dueJobs, latestSlot } from "./cron-schedule";

const at = (iso: string): number => Date.parse(iso);

describe("latestSlot", () => {
    it("aligns intervals to the UTC epoch, like the cron expressions they replace", () => {
        expect(latestSlot({ everyMinutes: 60, kind: "interval" }, at("2026-09-23T11:42:10Z"))).toBe(at("2026-09-23T11:00:00Z"));
        expect(latestSlot({ everyMinutes: 360, kind: "interval" }, at("2026-09-23T11:42:10Z"))).toBe(at("2026-09-23T06:00:00Z"));
        expect(latestSlot({ everyMinutes: 10, kind: "interval" }, at("2026-09-23T11:42:10Z"))).toBe(at("2026-09-23T11:40:00Z"));
    });

    it("puts a daily slot on its UTC time — today once passed, else yesterday", () => {
        const vacuum = { hourUTC: 3, kind: "daily", minuteUTC: 30 } as const;

        expect(latestSlot(vacuum, at("2026-09-23T03:30:00Z"))).toBe(at("2026-09-23T03:30:00Z"));
        expect(latestSlot(vacuum, at("2026-09-23T11:00:00Z"))).toBe(at("2026-09-23T03:30:00Z"));
        expect(latestSlot(vacuum, at("2026-09-23T03:29:59Z"))).toBe(at("2026-09-22T03:30:00Z"));
    });
});

describe("dueJobs", () => {
    const hourly: PeriodicJob = { name: "hourly", schedule: { everyMinutes: 60, kind: "interval" } };
    const daily: PeriodicJob = { name: "daily", schedule: { hourUTC: 0, kind: "daily", minuteUTC: 0 } };

    it("is due once its slot is newer than the one it last ran for, and not before", () => {
        const now = at("2026-09-23T11:00:30Z");

        expect(dueJobs([hourly], { hourly: at("2026-09-23T10:00:00Z") }, now)).toStrictEqual([{ name: "hourly", slot: at("2026-09-23T11:00:00Z") }]);
        expect(dueJobs([hourly], { hourly: at("2026-09-23T11:00:00Z") }, now)).toStrictEqual([]);
        expect(dueJobs([daily], { daily: at("2026-09-23T00:00:00Z") }, now)).toStrictEqual([]);
    });

    it("runs a job never claimed right away", () => {
        expect(dueJobs([hourly], {}, at("2026-09-23T11:17:00Z")).map((job) => job.name)).toStrictEqual(["hourly"]);
    });

    it("runs a job that missed several slots once, for the latest", () => {
        expect(dueJobs([hourly], { hourly: at("2026-09-23T06:00:00Z") }, at("2026-09-23T11:05:00Z"))).toStrictEqual([
            { name: "hourly", slot: at("2026-09-23T11:00:00Z") },
        ]);
    });
});

describe("the single cron trigger", () => {
    it("registers one expression — Cloudflare allows at most three — dispatching only the tick", () => {
        expect(LUNORA_CRON_TRIGGERS).toStrictEqual(["*/1 * * * *"]);
        expect(LUNORA_CRONS["*/1 * * * *"]?.map((job) => job.functionPath)).toStrictEqual(["crons:cronTick"]);
    });

    it("keeps every periodic job's cadence", () => {
        const schedules = Object.fromEntries(PERIODIC_JOBS.map((job) => [job.name, job.schedule]));

        expect(schedules).toStrictEqual({
            cleanupExpiredExports: { everyMinutes: 360, kind: "interval" },
            deleteExpiredTemporaryChats: { everyMinutes: 60, kind: "interval" },
            deleteUnusedFiles: { everyMinutes: 60, kind: "interval" },
            dispatchShardHousekeeping: { everyMinutes: 10, kind: "interval" },
            handleGdprRequestTimeouts: { hourUTC: 0, kind: "daily", minuteUTC: 0 },
            keepAlive: { everyMinutes: 10, kind: "interval" },
            purgeActionCache: { everyMinutes: 60, kind: "interval" },
            purgeIdempotencyClaims: { everyMinutes: 60, kind: "interval" },
            vacuumDocumentHistory: { hourUTC: 3, kind: "daily", minuteUTC: 30 },
        });
    });
});

describe("claimDueCronJobs", () => {
    let harness: ReturnType<typeof lunoraTest>;

    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    const claim = async (now: number): Promise<string[]> => await harness.run(async (ctx: any) => await ctx.runMutation(claimDueCronJobs, { now }));

    it("claims each due slot once, so a duplicate tick runs nothing twice", async () => {
        const first = await claim(at("2026-09-23T11:00:20Z"));

        expect(first.toSorted(compareStrings)).toStrictEqual(PERIODIC_JOBS.map((job) => job.name).toSorted(compareStrings));
        // The same minute again (a retried or duplicated cron fire).
        expect(await claim(at("2026-09-23T11:00:40Z"))).toStrictEqual([]);
        // Ten minutes on: only the ten-minute jobs.
        const tenMinutesOn = await claim(at("2026-09-23T11:10:05Z"));

        expect(tenMinutesOn.toSorted(compareStrings)).toStrictEqual(["dispatchShardHousekeeping", "keepAlive"]);
        // 12:00: the hourly jobs, the ten-minute one, and the six-hourly one (`0 */6` fires at 12); not the daily ones.
        const noon = await claim(at("2026-09-23T12:00:05Z"));

        expect(noon.toSorted(compareStrings)).toStrictEqual([
            "cleanupExpiredExports",
            "deleteExpiredTemporaryChats",
            "deleteUnusedFiles",
            "dispatchShardHousekeeping",
            "keepAlive",
            "purgeActionCache",
            "purgeIdempotencyClaims",
        ]);
        // 13:00: no six-hourly slot.
        expect(await claim(at("2026-09-23T13:00:05Z"))).not.toContain("cleanupExpiredExports");
        // 03:30 the next day: the daily vacuum is due; midnight's GDPR check already ran at 00:00.
        expect(await claim(at("2026-09-24T03:30:05Z"))).toContain("vacuumDocumentHistory");
    });
});

describe("runCronTick", () => {
    it("runs the one-minute jobs every tick and a periodic job only when claimed, isolating failures", async () => {
        const calls: string[] = [];
        const runMutation = vi.fn(async (reference: unknown, args: Record<string, unknown>) => {
            const path = (reference as { __lunoraRef?: string }).__lunoraRef ?? String(reference);

            calls.push(path);

            if (path === "crons:claimDueCronJobs") {
                expect(args).toStrictEqual({ now: 123 });

                return ["purgeActionCache"];
            }

            if (path === "workflow_presence:cleanupStalePresence") {
                throw new Error("boom");
            }

            return null;
        });

        const result = await runCronTick({ runMutation } as never, 123);

        expect(calls).toStrictEqual([
            "triggers_schedule:checkDueTriggers",
            "chat_streaming_persistent_crons:cleanupExpiredStreams",
            "workflow_presence:cleanupStalePresence",
            "lib_claim_once:reapLapsedClaims",
            "lib_shard_housekeeping:dispatchDueShards",
            "crons:claimDueCronJobs",
            "crons:purgeActionCache",
        ]);
        expect(result).toStrictEqual({
            failed: ["cleanupStaleWorkflowPresence"],
            ran: ["checkDueTriggers", "cleanupExpiredPersistentStreams", "reapLapsedClaims", "dispatchDueShards", "purgeActionCache"],
        });
    });
});
