/**
 * What the thread view reads of a goal: the owner sees it while its chat exists, and nothing once the chat is gone.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { clearPinnedGoal, getPinnedGoal, getThreadGoal, setPinnedGoal } from "./functions";

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
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { deleted: true, deletedAt: 1 }));

        expect(await as(OWNER).query(getThreadGoal as never, { threadId } as never)).toBeNull();
    });

    it("shows nothing once the chat is gone, whatever rows are left behind", async () => {
        await harness.run(async (ctx: any) => await ctx.db.delete("threads", threadId));

        expect(await as(OWNER).query(getThreadGoal as never, { threadId } as never)).toBeNull();
    });
});

describe("pinned goal", () => {
    it("pins the trimmed text and rounds, and replaces an earlier pin", async () => {
        await as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 3, text: "  Ship the report  ", threadId } as never);
        await as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 10, text: "Ship the report", threadId } as never);

        expect(await as(OWNER).query(getPinnedGoal as never, { threadId } as never)).toEqual({ maxRounds: 10, text: "Ship the report" });
    });

    it("clears in one action", async () => {
        await as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 5, text: "Ship it", threadId } as never);
        await as(OWNER).mutation(clearPinnedGoal as never, { threadId } as never);

        expect(await as(OWNER).query(getPinnedGoal as never, { threadId } as never)).toBeNull();
    });

    it("refuses a pin from anyone but the owner, and shows it to no one else", async () => {
        await as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 5, text: "Ship it", threadId } as never);

        await expect(as("stranger").mutation(setPinnedGoal as never, { maxRounds: 5, text: "Steal", threadId } as never)).rejects.toThrow();
        await expect(as("stranger").mutation(clearPinnedGoal as never, { threadId } as never)).rejects.toThrow();
        expect(await as("stranger").query(getPinnedGoal as never, { threadId } as never)).toBeNull();
    });

    it("refuses blank text and rounds outside the allowed range", async () => {
        await expect(as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 5, text: " ".repeat(3), threadId } as never)).rejects.toThrow();
        await expect(as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 0, text: "Ship it", threadId } as never)).rejects.toThrow();
        await expect(as(OWNER).mutation(setPinnedGoal as never, { maxRounds: 1.5, text: "Ship it", threadId } as never)).rejects.toThrow();
        expect(await as(OWNER).query(getPinnedGoal as never, { threadId } as never)).toBeNull();
    });
});
