/**
 * A reflection run that lands outside its local night window books the next
 * night instead of going quiet until the user chats again.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { claimReflectionRun } from "./reflection";
import { checkReflectionEligibility, nextReflectionRunAt } from "./reflection-logic";

const { registry } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const USER = "user-a";
const HOUR = 60 * 60 * 1000;
// 13:00 UTC: past the 02:00-06:00 night window, so the job is late.
const LATE = Date.UTC(2026, 8, 25, 13, 0);

let harness: ReturnType<typeof lunoraTest>;

const claim = async (): Promise<{ claimed: boolean; reason?: string }> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(claimReflectionRun, { userId: USER }));

const state = async () => await harness.run(async (ctx: any) => await ctx.db.memoryReflectionState.findFirst({ where: { userId: USER } }));

const patchState = async (fields: Record<string, unknown>) =>
    await harness.run(async (ctx: any) => {
        const row = await ctx.db.memoryReflectionState.findFirst({ where: { userId: USER } });

        await ctx.db.patch(row._id, fields);
    });

// Nothing else schedules in these tests, and a by-reference job carries no path in the harness.
const jobs = () => harness.scheduler.list().filter((job) => job.args.userId === USER);

beforeAll(async () => {
    registerModule(registry, "memory_reflection", await import("./reflection"));
});

beforeEach(async () => {
    vi.useFakeTimers({ now: LATE, toFake: ["Date"] });
    harness = lunoraTest(schema as never);

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { memoryEnabled: true, timezone: "UTC", userId: USER });
        await ctx.db.insert("memoryReflectionState", { lastActiveAt: LATE - HOUR, userId: USER });
    });
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("a reflection claim outside the night window", () => {
    it("books exactly one job at the next local night", async () => {
        await expect(claim()).resolves.toEqual({ claimed: false, reason: "outside_window" });

        const expected = nextReflectionRunAt(LATE, "UTC", USER);

        expect(jobs()).toHaveLength(1);
        expect(jobs()[0]?.scheduledFor).toBe(expected);
        expect(await state()).toMatchObject({ scheduledFor: expected, scheduledJobId: jobs()[0]?.id });
        expect(new Date(expected).getUTCHours()).toBe(3);
        expect(new Date(expected).getUTCDate()).toBe(26);
    });

    it("books a time that is strictly later and passes eligibility in the same zone", () => {
        for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
            for (let hour = 0; hour < 24; hour += 1) {
                const now = Date.UTC(2026, 2, 28, hour, 17);
                const next = nextReflectionRunAt(now, zone, USER);

                expect(next).toBeGreaterThan(now);
                expect(
                    checkReflectionEligibility({ lastActiveAt: next - HOUR, lastRunLocalDay: undefined, memoryEnabled: true, now: next, timeZone: zone }),
                ).toMatchObject({
                    eligible: true,
                });
            }
        }
    });

    it("still clears the pending job when memory is off", async () => {
        await harness.run(async (ctx: any) => {
            const settings = await ctx.db.userSettings.findFirst({ where: { userId: USER } });

            await ctx.db.patch(settings._id, { memoryEnabled: false });
        });
        await patchState({ scheduledFor: LATE - 1000, scheduledJobId: "job-old" });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "memory_disabled" });
        expect(jobs()).toHaveLength(0);
        expect((await state()).scheduledFor).toBeUndefined();
        expect((await state()).scheduledJobId).toBeUndefined();
    });

    it("still clears the pending job when the user is inactive", async () => {
        await patchState({ lastActiveAt: LATE - 2 * 24 * HOUR, scheduledFor: LATE - 1000, scheduledJobId: "job-old" });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "inactive" });
        expect(jobs()).toHaveLength(0);
        expect((await state()).scheduledFor).toBeUndefined();
        expect((await state()).scheduledJobId).toBeUndefined();
    });

    it("books nothing when activity already scheduled a later job", async () => {
        const later = nextReflectionRunAt(LATE, "UTC", USER);

        await patchState({ scheduledFor: later, scheduledJobId: "job-later" });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "outside_window" });
        expect(jobs()).toHaveLength(0);
        expect(await state()).toMatchObject({ scheduledFor: later, scheduledJobId: "job-later" });
    });
});
