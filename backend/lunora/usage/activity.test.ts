/**
 * The usage rollup against the in-memory harness: the writer's per-day upsert,
 * the heatmap's window and the per-skill breakdown, each scoped to the caller.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getActivityHeatmap, getProjectBreakdown, getProjectUsage, getSkillBreakdown, recordReplyUsage } from "./activity";
import { DEFAULT_SKILL_KEY } from "./activity-logic";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const USER = "user-a";
const OTHER = "user-b";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);

interface Heatmap {
    days: { costMicrodollars: number; date: string; replies: number; tokens: number }[];
    trackingSince?: string;
}

interface Breakdown {
    skills: { costMicrodollars: number; replies: number; skillKey: string; skillName?: string; tokens: number }[];
    truncated: boolean;
}

const heatmap = async (userId: string, toDate: string): Promise<Heatmap> =>
    (await as(userId).query(getActivityHeatmap as never, { toDate } as never)) as Heatmap;

const breakdown = async (userId: string, fromDate: string): Promise<Breakdown> =>
    (await as(userId).query(getSkillBreakdown as never, { fromDate } as never)) as Breakdown;

let replies = 0;

/** One reply's record; each call is a different reply unless `replyKey` says otherwise. */
const record = async (args: Record<string, unknown>) => {
    replies += 1;

    const replyKey = `reply-${String(replies)}`;

    return await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(recordReplyUsage, {
                at: 1,
                costMicrodollars: 100,
                date: "2026-09-20",
                replyKey,
                skillKey: DEFAULT_SKILL_KEY,
                tokens: 10,
                userId: USER,
                ...args,
            }),
    );
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("recordReplyUsage + getActivityHeatmap", () => {
    it("adds every reply of a day into one total, across skills", async () => {
        await record({});
        await record({ costMicrodollars: 50, skillKey: "sk_1", skillName: "/writer", tokens: 5 });
        await record({ date: "2026-09-21" });

        const result = await heatmap(USER, "2026-09-25");

        expect(result.trackingSince).toBe("2026-09-20");
        expect(result.days).toStrictEqual([
            { costMicrodollars: 150, date: "2026-09-20", replies: 2, tokens: 15 },
            { costMicrodollars: 100, date: "2026-09-21", replies: 1, tokens: 10 },
        ]);
    });

    it("reads only the 53 weeks ending at toDate", async () => {
        await record({ date: "2025-09-19" });
        await record({ date: "2025-09-20" });
        await record({ date: "2026-09-26" });

        const result = await heatmap(USER, "2026-09-25");

        expect(result.days.map((day) => day.date)).toStrictEqual(["2025-09-20"]);
        expect(result.trackingSince).toBe("2025-09-19");
    });

    it("shows a user only their own days", async () => {
        await record({ userId: OTHER });

        expect(await heatmap(USER, "2026-09-25")).toStrictEqual({ days: [] });
        const theirs = await heatmap(OTHER, "2026-09-25");

        expect(theirs.days).toHaveLength(1);
    });

    it("counts a redelivered record once", async () => {
        await record({ replyKey: "task-run-1" });
        await record({ replyKey: "task-run-1" });
        await record({ replyKey: "task-run-1", userId: OTHER });

        const mine = await heatmap(USER, "2026-09-25");
        const theirs = await heatmap(OTHER, "2026-09-25");

        expect(mine.days).toStrictEqual([{ costMicrodollars: 100, date: "2026-09-20", replies: 1, tokens: 10 }]);
        expect(theirs.days).toHaveLength(1);
    });

    it("refuses a date that is not YYYY-MM-DD", async () => {
        await expect(heatmap(USER, "2026-9-25")).rejects.toThrow();
    });
});

describe("getSkillBreakdown", () => {
    it("sums per skill from fromDate on, costliest first", async () => {
        await record({ date: "2026-09-01", skillKey: "sk_1", skillName: "/writer" });
        await record({ costMicrodollars: 300, date: "2026-09-20", skillKey: "sk_1", skillName: "/writer" });
        await record({ costMicrodollars: 40, date: "2026-09-21" });
        await record({ date: "2026-09-22", userId: OTHER });

        const result = await breakdown(USER, "2026-09-15");

        expect(result.truncated).toBe(false);
        expect(result.skills).toStrictEqual([
            { costMicrodollars: 300, replies: 1, skillKey: "sk_1", skillName: "/writer", tokens: 10 },
            { costMicrodollars: 40, replies: 1, skillKey: DEFAULT_SKILL_KEY, tokens: 10 },
        ]);
    });
});

describe("usage by project", () => {
    interface Totals {
        costMicrodollars: number;
        replies: number;
        tokens: number;
    }

    interface ProjectBreakdown {
        noProject: Totals;
        projects: (Totals & { projectKey: string; title?: string })[];
        total: Totals;
        truncated: boolean;
        unfiled?: { from: string; to: string };
    }

    const projectBreakdown = async (userId: string, fromDate: string): Promise<ProjectBreakdown> =>
        (await as(userId).query(getProjectBreakdown as never, { fromDate } as never)) as ProjectBreakdown;

    const projectUsage = async (userId: string, projectId: string, fromDate: string): Promise<Totals> => {
        const { truncated, ...totals } = (await as(userId).query(getProjectUsage as never, { fromDate, projectId } as never)) as Totals & {
            truncated: boolean;
        };

        expect(truncated).toBe(false);

        return totals;
    };

    /** A project of `userId`'s and a thread of theirs in it (or in none). */
    const insertThread = async (userId: string, title?: string): Promise<{ projectId?: string; threadId: string }> =>
        await harness.run(async (ctx: any) => {
            const projectId = title === undefined ? undefined : await ctx.db.insert("projects", { createdAt: 1, title, userId });
            const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId, ...(projectId !== undefined && { projectId }) });

            return { projectId, threadId };
        });

    it("shows two threads in two projects as separate totals that add up to the overall total", async () => {
        const alpha = await insertThread(USER, "Alpha");
        const beta = await insertThread(USER, "Beta");
        const loose = await insertThread(USER);

        await record({ costMicrodollars: 300, threadId: alpha.threadId, tokens: 30 });
        await record({ costMicrodollars: 200, skillKey: "sk_1", skillName: "/writer", threadId: alpha.threadId, tokens: 20 });
        await record({ costMicrodollars: 100, date: "2026-09-21", threadId: beta.threadId, tokens: 10 });
        await record({ costMicrodollars: 7, threadId: loose.threadId, tokens: 1 });
        await record({ costMicrodollars: 3, tokens: 1 });

        const result = await projectBreakdown(USER, "2026-09-01");

        expect(result.projects).toStrictEqual([
            { costMicrodollars: 500, projectKey: alpha.projectId, replies: 2, title: "Alpha", tokens: 50 },
            { costMicrodollars: 100, projectKey: beta.projectId, replies: 1, title: "Beta", tokens: 10 },
        ]);
        expect(result.noProject).toStrictEqual({ costMicrodollars: 10, replies: 2, tokens: 2 });
        expect(result.total).toStrictEqual({ costMicrodollars: 610, replies: 5, tokens: 62 });

        const sum = [...result.projects, result.noProject].reduce((total, row) => total + row.costMicrodollars, 0);

        expect(sum).toBe(result.total.costMicrodollars);
        expect(await projectUsage(USER, alpha.projectId!, "2026-09-01")).toStrictEqual({ costMicrodollars: 500, replies: 2, tokens: 50 });
        expect(await projectUsage(USER, beta.projectId!, "2026-09-21")).toStrictEqual({ costMicrodollars: 100, replies: 1, tokens: 10 });

        // The skill breakdown is unchanged by the project rows.
        const skills = await breakdown(USER, "2026-09-01");

        expect(skills.skills.reduce((total, skill) => total + skill.costMicrodollars, 0)).toBe(610);
    });

    it("keeps a moved thread's past usage with the project it was recorded under", async () => {
        const alpha = await insertThread(USER, "Alpha");
        const beta = await insertThread(USER, "Beta");

        await record({ costMicrodollars: 100, replyKey: "before-move", threadId: alpha.threadId, tokens: 10 });
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", alpha.threadId, { projectId: beta.projectId });
        });
        await record({ costMicrodollars: 40, replyKey: "after-move", threadId: alpha.threadId, tokens: 4 });

        expect(await projectUsage(USER, alpha.projectId!, "2026-09-01")).toStrictEqual({ costMicrodollars: 100, replies: 1, tokens: 10 });
        expect(await projectUsage(USER, beta.projectId!, "2026-09-01")).toStrictEqual({ costMicrodollars: 40, replies: 1, tokens: 4 });
    });

    it("files a redelivered record under its project once", async () => {
        const alpha = await insertThread(USER, "Alpha");

        await record({ replyKey: "run-1", threadId: alpha.threadId });
        await record({ replyKey: "run-1", threadId: alpha.threadId });

        expect(await projectUsage(USER, alpha.projectId!, "2026-09-01")).toStrictEqual({ costMicrodollars: 100, replies: 1, tokens: 10 });
    });

    it("shows a user only their own project usage", async () => {
        const alpha = await insertThread(USER, "Alpha");

        await record({ threadId: alpha.threadId });

        expect(await projectUsage(OTHER, alpha.projectId!, "2026-09-01")).toStrictEqual({ costMicrodollars: 0, replies: 0, tokens: 0 });
        const theirs = await projectBreakdown(OTHER, "2026-09-01");

        expect(theirs.projects).toStrictEqual([]);
    });

    it("says when a project's period held more rows than one read sums", async () => {
        const alpha = await insertThread(USER, "Alpha");

        await harness.run(async (ctx: any) => {
            for (let day = 0; day <= 53 * 7 * 2; day += 1) {
                const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);

                await ctx.db.insert("usageDaily", {
                    costMicrodollars: 1,
                    date,
                    projectKey: alpha.projectId,
                    replies: 1,
                    skillKey: "__project__",
                    tokens: 1,
                    updatedAt: 1,
                    userId: USER,
                });
            }
        });

        const result = (await as(USER).query(getProjectUsage as never, { fromDate: "2025-01-01", projectId: alpha.projectId } as never)) as {
            costMicrodollars: number;
            truncated: boolean;
        };

        expect(result.truncated).toBe(true);
        expect(result.costMicrodollars).toBe(53 * 7 * 2);
    });

    it("writes no marker rows beyond the reply's own key when it records a reply first", async () => {
        const alpha = await insertThread(USER, "Alpha");

        await record({ replyKey: "first-record", threadId: alpha.threadId });

        const keys = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.usageReplies.findMany({ where: { userId: USER } });

            return page.map((row: { replyKey: string }) => row.replyKey);
        });

        expect(keys).toStrictEqual(["first-record"]);
    });

    it("sums the projects over the days the total covers, so they never exceed it when the total is cut short", async () => {
        const alpha = await insertThread(USER, "Alpha");

        await harness.run(async (ctx: any) => {
            const days = 53 * 7 * 2 + 3;

            for (let day = 0; day < days; day += 1) {
                const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
                const row = { costMicrodollars: 1, date, replies: 1, tokens: 1, updatedAt: 1, userId: USER };

                await ctx.db.insert("usageDaily", { ...row, skillKey: "__total__" });
                await ctx.db.insert("usageDaily", { ...row, projectKey: alpha.projectId, skillKey: "__project__" });
            }
        });

        const result = await projectBreakdown(USER, "2025-01-01");

        expect(result.truncated).toBe(true);
        expect(result.projects[0]!.costMicrodollars).toBe(result.total.costMicrodollars);
        expect(result.noProject.costMicrodollars).toBe(0);
    });

    it("leaves out a day the project read reached only in part, so No project never takes that day's project spend", async () => {
        const projectKeys = ["p1", "p2", "p3", "p4", "p5", "p6"];
        // Six project rows a day: the read stops two rows into its oldest day.
        const days = Math.ceil((4000 + 1) / projectKeys.length);

        await harness.run(async (ctx: any) => {
            for (let day = 0; day < days; day += 1) {
                const date = new Date(Date.UTC(2025, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
                const row = { date, replies: 1, tokens: 1, updatedAt: 1, userId: USER };

                await ctx.db.insert("usageDaily", { ...row, costMicrodollars: projectKeys.length, replies: projectKeys.length, skillKey: "__total__" });

                for (const projectKey of projectKeys) {
                    await ctx.db.insert("usageDaily", { ...row, costMicrodollars: 1, projectKey, skillKey: "__project__" });
                }
            }
        });

        const result = await projectBreakdown(USER, "2025-01-01");

        expect(result.truncated).toBe(true);
        expect(result.noProject).toStrictEqual({ costMicrodollars: 0, replies: 0, tokens: 0 });
        expect(result.total.costMicrodollars).toBe((days - 1) * projectKeys.length);
    });

    it("says which days were recorded before usage was filed by project", async () => {
        const day = 24 * 60 * 60 * 1000;
        const first = Date.UTC(2026, 8, 1, 12);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageBackfill", {
                leaseUntil: 0,
                projects: { leaseUntil: 0, replies: 0, runId: "p", startedAt: first + 10 * day, status: "done" },
                replies: 0,
                runId: "r",
                startedAt: first,
                status: "done",
                timeZone: "UTC",
                updatedAt: 0,
                userId: USER,
            });
        });

        const spanning = await projectBreakdown(USER, "2026-09-05");
        const after = await projectBreakdown(USER, "2026-09-12");

        expect(spanning.unfiled).toStrictEqual({ from: "2026-09-05", to: "2026-09-11" });
        expect(after.unfiled).toBeUndefined();
    });
});
