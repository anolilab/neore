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
    }

    const projectBreakdown = async (userId: string, fromDate: string): Promise<ProjectBreakdown> =>
        (await as(userId).query(getProjectBreakdown as never, { fromDate } as never)) as ProjectBreakdown;

    const projectUsage = async (userId: string, projectId: string, fromDate: string): Promise<Totals> =>
        (await as(userId).query(getProjectUsage as never, { fromDate, projectId } as never)) as Totals;

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
});
