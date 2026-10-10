/**
 * The home dashboard query: what it gathers, and that it only ever reads the
 * caller's rows — a collaborator reaches every procedure on the owner's shard,
 * so the per-user `where` is the control.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import { getHomeOverview } from "./overview";

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

/** A minimal `vToolRunConfig`, as in `chat/lib/tool-approval-cleanup.test.ts`. */
const CONFIG = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: [],
};

const USER = "user-a";
const OTHER = "user-b";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const overview = async (userId: string): Promise<any> => await harness.withIdentity({ userId } as never).query(getHomeOverview as never, {} as never);

/** Seeds one of everything the page shows for `userId`. */
const seed = async (userId: string) =>
    await harness.run(async (ctx: any) => {
        const now = Date.now();
        const threadId = await ctx.db.insert("threads", { status: "regular", title: `Plans of ${userId}`, updatedAt: now, userId });

        await ctx.db.insert("toolApprovalRuns", { approvalId: `a-${userId}`, config: CONFIG, createdAt: now, status: "pending", threadId, userId });
        await ctx.db.insert("tasks", {
            attemptCount: 0,
            createdAt: now,
            dependsOn: [],
            instructions: "Do it",
            maxRepairRounds: 1,
            recurring: false,
            status: "running",
            title: `Task of ${userId}`,
            updatedAt: now,
            userId,
        });
        await ctx.db.insert("notifications", { createdAt: now, title: "Nightly build", type: "task", userId });
        await ctx.db.insert("userSettings", { dailyBriefEnabled: true, userId });
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("getHomeOverview", () => {
    it("gathers what needs the user, what runs, their threads and unread notifications", async () => {
        await seed(USER);

        const result = await overview(USER);

        expect(result.approvals).toEqual([expect.objectContaining({ approvalId: `a-${USER}`, threadTitle: `Plans of ${USER}` })]);
        expect(result.runningTasks.map((task: { title: string }) => task.title)).toEqual([`Task of ${USER}`]);
        expect(result.recentThreads.map((thread: { title: string }) => thread.title)).toEqual([`Plans of ${USER}`]);
        expect(result.unreadCount).toBe(1);
        expect(result.dailyBriefEnabled).toBe(true);
    });

    it("lists recent threads by last update, never a soft-deleted or temporary one, however many there are", async () => {
        await harness.run(async (ctx: any) => {
            const base = Date.now() - 1_000_000;

            // Created first, updated last: it must lead.
            await ctx.db.insert("threads", { status: "regular", title: "Old but active", updatedAt: base + 900_000, userId: USER });

            // More soft-deleted rows than the scan reads — they used to sort first.
            for (let index = 0; index < 30; index += 1) {
                await ctx.db.insert("threads", {
                    deleted: true,
                    status: "regular",
                    title: `Deleted ${String(index)}`,
                    updatedAt: base + 800_000,
                    userId: USER,
                });
            }

            await ctx.db.insert("threads", { isTemporary: true, status: "regular", title: "Temporary", updatedAt: base + 850_000, userId: USER });
            await ctx.db.insert("threads", { deleted: false, status: "archived", title: "Newer, quiet", updatedAt: base + 100_000, userId: USER });
        });

        const result = await overview(USER);

        expect(result.recentThreads.map((thread: { title: string }) => thread.title)).toEqual(["Old but active", "Newer, quiet"]);
    });

    it("shows nothing of another user's", async () => {
        await seed(OTHER);

        expect(await overview(USER)).toMatchObject({
            approvals: [],
            codingAgents: [],
            dailyBriefEnabled: false,
            notifications: [],
            recentThreads: [],
            reviews: [],
            runningTasks: [],
            subAgents: [],
            unreadCount: 0,
        });
    });
});
