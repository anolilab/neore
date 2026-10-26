/**
 * The daily brief is billed only for a summary the model actually wrote: a
 * failed model call still delivers the plain counts, uncharged.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { createRatelimit } from "../lib/rate-limiter";
import schema from "../schema";
import { LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import { chargeDailyBrief, claimDailyBrief, loadDailyBriefInputs, runDailyBrief } from "./daily-brief";
import { checkBriefEligibility, nextBriefRunAt } from "./daily-brief-logic";

const { generateText, registry, users } = vi.hoisted(() => {
    return { generateText: vi.fn(), registry: new Map<string, unknown>(), users: new Set<string>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("ai", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("ai")>()), generateText };
});

vi.mock("../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            return {};
        },
    };
});

// `user` is a `.global()` (D1) table the in-memory harness cannot write.
vi.mock("../auth/lib/better-auth-queries", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth/lib/better-auth-queries")>()),
        getUser: async (_ctx: unknown, userId: string) => (users.has(userId) ? { _id: userId } : null),
    };
});

const USER = "user-a";
// 07:30 UTC — inside the brief's local-morning window for a UTC user.
const NOW = Date.UTC(2026, 8, 25, 7, 30);

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const remainingRuns = async (): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { remaining } = await createRatelimit("tasks/dailyRuns:free", ctx.db as never).getRemaining(USER);

        return remaining;
    });

const briefs = async (): Promise<{ body?: string; type: string }[]> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("notifications").collect();

        return rows.filter((row: any) => row.type === "daily_brief");
    });

beforeAll(async () => {
    registerModule(registry, "notifications_daily_brief", await import("./daily-brief"));
});

beforeEach(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
    users.add(USER);
    harness = lunoraTest(schema as never);

    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { dailyBriefEnabled: true, timezone: "UTC", userId: USER });
        await ctx.db.insert("dailyBriefState", { lastActiveAt: NOW - 60_000, userId: USER });
        await ctx.db.insert("notifications", { createdAt: NOW - 3_600_000, outcome: "success", title: "Nightly report", type: "task", userId: USER });
    });
});

afterEach(() => {
    harness.close();
    users.clear();
    generateText.mockReset();
    vi.useRealTimers();
});

describe("daily brief billing", () => {
    it("does not charge when the model call fails, and still writes the counts", async () => {
        generateText.mockRejectedValue(new Error("model down"));

        const before = await remainingRuns();

        await harness.action(async (ctx: any) => await ctx.runAction(runDailyBrief, { userId: USER }));

        expect(await remainingRuns()).toBe(before);
        await expect(briefs()).resolves.toHaveLength(1);
    });

    it("charges once for a summary the model wrote (control)", async () => {
        generateText.mockResolvedValue({ text: "One task finished overnight." });

        const before = await remainingRuns();

        await harness.action(async (ctx: any) => await ctx.runAction(runDailyBrief, { userId: USER }));

        expect(await remainingRuns()).toBe(before - 1);
        const [brief] = await briefs();

        expect(brief?.body).toBe("One task finished overnight.");
    });

    it("checkOnly consumes nothing", async () => {
        const before = await remainingRuns();

        await expect(harness.run(async (ctx: any) => await ctx.runMutation(chargeDailyBrief, { checkOnly: true, userId: USER }))).resolves.toBe("charged");
        expect(await remainingRuns()).toBe(before);
    });
});

describe("the summarizer's input", () => {
    type Inputs = { events: { title: string; type: string }[] };

    const inputsSince = async (since: number): Promise<Inputs> =>
        await harness.run(
            async (ctx: any) =>
                await (loadDailyBriefInputs as unknown as { handler: (ctx: unknown, args: unknown) => Promise<Inputs> }).handler(ctx, { since, userId: USER }),
        );

    it("names a notification of a chat locked after it was written by the generic title only", async () => {
        await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "regular", title: "Salary", updatedAt: NOW, userId: USER });

            await ctx.db.insert("notifications", { createdAt: NOW - 1000, link: `/chat/${threadId}`, title: "Salary", type: "task", userId: USER });
            await ctx.db.patch(threadId, { lockedAt: NOW });
        });

        const { events } = await inputsSince(NOW - 60_000);

        expect(events).toEqual([{ title: LOCKED_THREAD_TITLE, type: "task" }]);
        expect(JSON.stringify(events)).not.toContain("Salary");
    });

    it("keeps the title of a notification linked to a chat that is not locked", async () => {
        await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "regular", title: "Plans", updatedAt: NOW, userId: USER });

            await ctx.db.insert("notifications", { createdAt: NOW - 1000, link: `/chat/${threadId}`, title: "Plans", type: "task", userId: USER });
        });

        const { events } = await inputsSince(NOW - 60_000);

        expect(events).toContainEqual({ title: "Plans", type: "task" });
    });
});

describe("a claim outside the morning window", () => {
    const HOUR = 60 * 60 * 1000;
    // 13:00 UTC: past the 06:00-11:00 window, so the job is late.
    const LATE = Date.UTC(2026, 8, 25, 13, 0);

    const claim = async (): Promise<{ claimed: boolean; reason?: string }> =>
        await harness.run(async (ctx: any) => await ctx.runMutation(claimDailyBrief, { userId: USER }));

    const state = async () => await harness.run(async (ctx: any) => await ctx.db.dailyBriefState.findFirst({ where: { userId: USER } }));

    // Nothing else schedules in these tests, and a by-reference job carries no path in the harness.
    const briefJobs = () => harness.scheduler.list().filter((job) => job.args.userId === USER);

    beforeEach(() => {
        vi.setSystemTime(LATE);
    });

    it("books exactly one job at the next local morning", async () => {
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.dailyBriefState.findFirst({ where: { userId: USER } });

            await ctx.db.patch(row._id, { lastActiveAt: LATE - HOUR });
        });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "outside_window" });

        const expected = nextBriefRunAt(LATE, "UTC", USER);
        const jobs = briefJobs();
        const row = await state();

        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.scheduledFor).toBe(expected);
        expect(row).toMatchObject({ scheduledFor: expected, scheduledJobId: jobs[0]?.id });
        expect(new Date(expected).getUTCHours()).toBe(7);
        expect(new Date(expected).getUTCDate()).toBe(26);
    });

    it("books a time that is strictly later and passes eligibility in the same zone", async () => {
        for (const zone of ["UTC", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Pacific/Auckland"]) {
            for (let hour = 0; hour < 24; hour += 1) {
                const now = Date.UTC(2026, 2, 28, hour, 17);
                const next = nextBriefRunAt(now, zone, USER);

                expect(next).toBeGreaterThan(now);
                expect(
                    checkBriefEligibility({ enabled: true, lastActiveAt: next - HOUR, lastRunLocalDay: undefined, now: next, timeZone: zone }),
                ).toMatchObject({
                    eligible: true,
                });
            }
        }
    });

    it("still clears the pending job when the user disabled the brief", async () => {
        await harness.run(async (ctx: any) => {
            const settings = await ctx.db.userSettings.findFirst({ where: { userId: USER } });
            const row = await ctx.db.dailyBriefState.findFirst({ where: { userId: USER } });

            await ctx.db.patch(settings._id, { dailyBriefEnabled: false });
            await ctx.db.patch(row._id, { lastActiveAt: LATE - HOUR, scheduledFor: LATE - 1000, scheduledJobId: "job-old" });
        });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "disabled" });
        expect(briefJobs()).toHaveLength(0);
        const row220 = await state();

        expect(row220.scheduledFor).toBeUndefined();
        const row221 = await state();

        expect(row221.scheduledJobId).toBeUndefined();
    });

    it("still clears the pending job when the user is inactive", async () => {
        await harness.run(async (ctx: any) => {
            const row = await ctx.db.dailyBriefState.findFirst({ where: { userId: USER } });

            await ctx.db.patch(row._id, { lastActiveAt: LATE - 3 * 24 * HOUR, scheduledFor: LATE - 1000, scheduledJobId: "job-old" });
        });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "inactive" });
        expect(briefJobs()).toHaveLength(0);
        const row233 = await state();

        expect(row233.scheduledFor).toBeUndefined();
        const row234 = await state();

        expect(row234.scheduledJobId).toBeUndefined();
    });

    it("books nothing when activity already scheduled a later job", async () => {
        const later = nextBriefRunAt(LATE, "UTC", USER);

        await harness.run(async (ctx: any) => {
            const row = await ctx.db.dailyBriefState.findFirst({ where: { userId: USER } });

            await ctx.db.patch(row._id, { lastActiveAt: LATE - HOUR, scheduledFor: later, scheduledJobId: "job-later" });
        });

        await expect(claim()).resolves.toEqual({ claimed: false, reason: "outside_window" });
        expect(briefJobs()).toHaveLength(0);
        expect(await state()).toMatchObject({ scheduledFor: later, scheduledJobId: "job-later" });
    });
});
