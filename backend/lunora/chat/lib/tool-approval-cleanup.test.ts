/**
 * Retention of `toolApprovalRuns` snapshots: they go with their thread, and the
 * cron purges resolved rows after a day and unanswered ones after a week.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { _deletePageForThreadId } from "../../agent/threads";
import schema from "../../schema";
import { PENDING_APPROVAL_TTL_MS, purgeExpiredToolApprovalRuns, purgeExpiredToolApprovalRunsForUser, RESOLVED_APPROVAL_TTL_MS } from "./tool-approval-cleanup";

type Harness = ReturnType<typeof lunoraTest>;

const CONFIG = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: [],
};

const NOW = 1_800_000_000_000;

let harness: Harness;

const insertRun = async (row: {
    approvalId: string;
    createdAt: number;
    resolvedAt?: number;
    status: "approved" | "denied" | "pending";
    threadId: string;
    userId?: string;
}) => await harness.run(async (ctx: any) => await ctx.db.insert("toolApprovalRuns", { config: CONFIG, userId: "u1", ...row }));

const remainingIds = async () =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("toolApprovalRuns").collect();

        return rows.map((r: { approvalId: string }) => r.approvalId).toSorted((a: string, b: string) => a.localeCompare(b));
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("thread deletion", () => {
    it("deletes the thread's approval snapshots and leaves other threads' alone", async () => {
        const [doomed, kept] = await harness.run(async (ctx: any) => [
            await ctx.db.insert("threads", { title: "A", userId: "u1" }),
            await ctx.db.insert("threads", { title: "B", userId: "u1" }),
        ]);

        await insertRun({ approvalId: "a1", createdAt: NOW, status: "pending", threadId: doomed });
        await insertRun({ approvalId: "a2", createdAt: NOW, resolvedAt: NOW, status: "approved", threadId: doomed });
        await insertRun({ approvalId: "b1", createdAt: NOW, status: "pending", threadId: kept });

        // Through ctx.runMutation: `_deletePageForThreadId` is internal, which the
        // harness (correctly) refuses to call from its external boundary.
        const result = await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId: doomed }));

        expect(result).toMatchObject({ isDone: true });
        expect(await remainingIds()).toStrictEqual(["b1"]);
    });
});

describe("purgeExpiredToolApprovalRuns", () => {
    it("purges resolved rows after one day and pending rows after seven", async () => {
        const threadId = "t1";

        // Resolved: expired / not yet.
        await insertRun({ approvalId: "approved-old", createdAt: 0, resolvedAt: NOW - RESOLVED_APPROVAL_TTL_MS - 1, status: "approved", threadId });
        await insertRun({ approvalId: "denied-old", createdAt: 0, resolvedAt: NOW - RESOLVED_APPROVAL_TTL_MS - 1, status: "denied", threadId });
        await insertRun({ approvalId: "approved-fresh", createdAt: 0, resolvedAt: NOW - RESOLVED_APPROVAL_TTL_MS + 60_000, status: "approved", threadId });
        // Pending: the one-day rule must NOT apply to them.
        await insertRun({ approvalId: "pending-old", createdAt: NOW - PENDING_APPROVAL_TTL_MS - 1, status: "pending", threadId });
        await insertRun({ approvalId: "pending-2d", createdAt: NOW - 2 * RESOLVED_APPROVAL_TTL_MS, status: "pending", threadId });

        const purged = await harness.run(async (ctx: any) => await purgeExpiredToolApprovalRuns(ctx, NOW));

        expect(purged).toBe(3);
        expect(await remainingIds()).toStrictEqual(["approved-fresh", "pending-2d"]);
    });

    it("is a no-op when nothing has expired", async () => {
        await insertRun({ approvalId: "p", createdAt: NOW, status: "pending", threadId: "t1" });

        expect(await harness.run(async (ctx: any) => await purgeExpiredToolApprovalRuns(ctx, NOW))).toBe(0);
        expect(await remainingIds()).toStrictEqual(["p"]);
    });
});

describe("purgeExpiredToolApprovalRunsForUser", () => {
    it("sweeps only the given user's expired rows, whatever shard the call lands on", async () => {
        await insertRun({ approvalId: "mine-old", createdAt: NOW - PENDING_APPROVAL_TTL_MS - 1, status: "pending", threadId: "t1" });
        await insertRun({ approvalId: "mine-resolved-old", createdAt: 0, resolvedAt: NOW - RESOLVED_APPROVAL_TTL_MS - 1, status: "denied", threadId: "t1" });
        await insertRun({ approvalId: "mine-fresh", createdAt: NOW, status: "pending", threadId: "t1" });
        await insertRun({ approvalId: "theirs-old", createdAt: NOW - PENDING_APPROVAL_TTL_MS - 1, status: "pending", threadId: "t2", userId: "u2" });

        const purged = await harness.run(async (ctx: any) => await purgeExpiredToolApprovalRunsForUser(ctx, "u1", NOW));

        expect(purged).toBe(2);
        expect(await remainingIds()).toStrictEqual(["mine-fresh", "theirs-old"]);
    });
});
