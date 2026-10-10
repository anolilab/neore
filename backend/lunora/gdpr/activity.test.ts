/**
 * `usageDaily` and `subAgentRuns` in the account deletion (batched past one
 * round), the export (with knowledge collections) and the retention sweep.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../lib/test-schema";
import { pruneRetainedActivity, RETENTION_BATCH, SUB_AGENT_RUN_RETENTION_DAYS, usageDailyCutoffDate } from "./retention";
import { collectActivityForExport } from "./steps";
import { BATCH, deleteUserSubAgentRuns, deleteUserUsageDaily } from "./steps/residual-deletion-steps";

type Harness = ReturnType<typeof lunoraTest>;

const A = "user-a";
const B = "user-b";
const DAY_MS = 24 * 60 * 60 * 1000;

let harness: Harness;

const usageRow = (userId: string, date: string, index = 0) => {
    return { costMicrodollars: 10, date, replies: 1, skillKey: `s${String(index)}`, tokens: 5, updatedAt: 0, userId };
};

const runRow = (userId: string, createdAt: number, status: string, index = 0) => {
    return { createdAt, depth: 1, parentThreadId: "t1", result: "answer", status, task: `task ${String(index)}`, updatedAt: createdAt, userId };
};

const count = async (table: string, userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db[table].findMany({ where: { userId } });

        return page.length;
    });

beforeEach(() => {
    harness = lunoraTest(schemaWithShardedTables(["knowledgeCollections"]) as never);
});

afterEach(() => {
    harness.close();
});

describe("account deletion of activity rows", () => {
    it("drains A's usage days and sub-agent runs past one batch, and leaves B's", async () => {
        const many = BATCH + 7;

        await harness.run(async (ctx: any) => {
            for (let index = 0; index < many; index += 1) {
                await ctx.db.insert("usageDaily", usageRow(A, "2026-01-01", index));
                await ctx.db.insert("subAgentRuns", runRow(A, index, "succeeded", index));
            }

            await ctx.db.insert("usageDaily", usageRow(B, "2026-01-01"));
            await ctx.db.insert("subAgentRuns", runRow(B, 0, "succeeded"));
        });

        for (const step of [deleteUserUsageDaily, deleteUserSubAgentRuns]) {
            const first = (await harness.run(async (ctx: any) => await ctx.runMutation(step, { userId: A }))) as { hasMore: boolean };

            expect(first.hasMore).toBe(true);

            const second = (await harness.run(async (ctx: any) => await ctx.runMutation(step, { userId: A }))) as { hasMore: boolean };

            expect(second.hasMore).toBe(false);
        }

        expect(await count("usageDaily", A)).toBe(0);
        expect(await count("subAgentRuns", A)).toBe(0);
        expect(await count("usageDaily", B)).toBe(1);
        expect(await count("subAgentRuns", B)).toBe(1);
    });
});

describe("collectActivityForExport", () => {
    it("exports the user's usage history, delegations with task and result, and collections — nobody else's", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageDaily", usageRow(A, "2026-02-01"));
            await ctx.db.insert("subAgentRuns", runRow(A, 1, "succeeded"));
            await ctx.db.insert("knowledgeCollections", { createdAt: 0, name: "Handbook", updatedAt: 0, userId: A });
            await ctx.db.insert("knowledgeCollections", { createdAt: 0, name: "Not mine", updatedAt: 0, userId: B });
        });

        const exported = (await harness.run(async (ctx: any) => await ctx.runQuery(collectActivityForExport, { userId: A }))) as any;

        expect(exported.usageDaily).toEqual([expect.objectContaining({ date: "2026-02-01", tokens: 5 })]);
        expect(exported.subAgentRuns).toEqual([expect.objectContaining({ result: "answer", status: "succeeded", task: "task 0" })]);
        expect(exported.knowledgeCollections.map((collection: { name: string }) => collection.name)).toEqual(["Handbook"]);
    });
});

describe("pruneRetainedActivity", () => {
    it("drops usage days past the window and old finished runs; keeps recent days and anything still running", async () => {
        const now = Date.now();
        const old = now - (SUB_AGENT_RUN_RETENTION_DAYS + 1) * DAY_MS;

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("usageDaily", usageRow(A, "2020-01-01"));
            await ctx.db.insert("usageDaily", usageRow(A, new Date(now).toISOString().slice(0, 10)));
            await ctx.db.insert("subAgentRuns", runRow(A, old, "succeeded"));
            await ctx.db.insert("subAgentRuns", runRow(A, old, "running", 1));
            await ctx.db.insert("subAgentRuns", runRow(A, now, "failed", 2));
        });

        const pruned = await harness.run(async (ctx: any) => await ctx.runMutation(pruneRetainedActivity, {}));

        expect(pruned).toEqual({ subAgentRuns: 1, usageDaily: 1 });
        expect(await count("usageDaily", A)).toBe(1);
        expect(await count("subAgentRuns", A)).toBe(2);
        expect(RETENTION_BATCH).toBeGreaterThan(0);
        expect(usageDailyCutoffDate(Date.UTC(2026, 0, 1))).toBe("2024-11-27");
    });
});
