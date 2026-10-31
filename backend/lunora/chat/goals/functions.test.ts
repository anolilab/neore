/**
 * What the thread view reads of a goal: the owner sees it while its chat exists, and nothing once the chat is gone.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { getThreadGoal } from "./functions";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
                : null,
    };
});

vi.mock("../../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const OWNER = "owner";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => {
        const thread = String(await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

        await ctx.db.insert("threadGoals", {
            config: { model: "m" },
            costMicrodollars: 0,
            createdAt: 1,
            maxCostMicrodollars: 1,
            maxRounds: 5,
            promptMessageId: "p",
            round: 0,
            startMessageId: "p",
            status: "active",
            text: "Ship the secret report",
            threadId: thread,
            updatedAt: 1,
            userId: OWNER,
            verdicts: [],
        });

        return thread;
    });
});

afterEach(() => {
    harness.close();
});

describe("getThreadGoal", () => {
    it("shows the owner their goal", async () => {
        expect(await as(OWNER).query(getThreadGoal as never, { threadId } as never)).toMatchObject({ status: "active", text: "Ship the secret report" });
    });

    it("shows nothing for a chat in the trash", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true, deletedAt: 1 }));

        expect(await as(OWNER).query(getThreadGoal as never, { threadId } as never)).toBeNull();
    });

    it("shows nothing once the chat is gone, whatever rows are left behind", async () => {
        await harness.run(async (ctx: any) => await ctx.db.delete(threadId));

        expect(await as(OWNER).query(getThreadGoal as never, { threadId } as never)).toBeNull();
    });
});
