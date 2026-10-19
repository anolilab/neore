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
import { chargeDailyBrief, loadDailyBriefInputs, runDailyBrief } from "./daily-brief";

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
