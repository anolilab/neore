/**
 * The four-hour reminder for a pending approval: one push per pause, once per approval, and only for requests in the window.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInShard } from "../../lib/shard-context";
import schema from "../../schema";
import { APPROVAL_REMINDER_AFTER_MS, APPROVAL_REMINDER_WINDOW_MS, remindPendingApprovals } from "./approval-reminder";

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
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let harness: Harness;

/** The thread the approvals hang off; set by the test that inserts it, so the rows name a real thread. */
let threadId = "";

const insertThread = async (): Promise<void> => {
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Owner thread", userId: "u1" }))) as string;
};

const insertRun = async (row: { approvalId: string; createdAt: number; status?: "approved" | "denied" | "pending"; threadId: string }) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", {
                config: CONFIG,
                status: "pending",
                userId: "u1",
                ...row,
            }),
    );

// Run as the owner's shard, where a notification for the owner is written here rather than handed to another shard.
const sweep = async (now: number) => await harness.run(async (ctx: any) => await runInShard("u1", () => remindPendingApprovals(ctx, now)));

const approvalPushes = async () =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("notifications").collect();

        return rows.filter((row: { type: string }) => row.type === "tool_approval");
    });

// The assistant turn that asked for the request, as the run saves it, so the sweep can read what kind of request it is.
const insertRequest = async (approvalId: string, toolName: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: {
                    content: [
                        { input: {}, toolCallId: `call-${approvalId}`, toolName, type: "tool-call" },
                        { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
                    ],
                    role: "assistant",
                },
                order: 1,
                status: "success",
                stepOrder: 0,
                threadId,
                tool: true,
                userId: "u1",
            }),
    );

const reminderOf = async (approvalId: string) =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("toolApprovalRuns").collect();

        return rows.find((row: { approvalId: string }) => row.approvalId === approvalId)?.reminderSentAt;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("the four-hour approval reminder", () => {
    it("reminds a request that has waited four hours, with one push", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });

        expect(await sweep(NOW)).toBe(1);

        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
    });

    it("sends one reminder per approval, not one per sweep", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });

        await sweep(NOW);
        const later = await sweep(NOW + MINUTE);

        expect(later).toBe(0);
        expect(await approvalPushes()).toHaveLength(1);
    });

    it("sends one push for the several approvals one pause asked for, and marks each of them", async () => {
        await insertThread();
        const createdAt = NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE;

        await insertRun({ approvalId: "a1", createdAt, threadId });
        await insertRun({ approvalId: "a2", createdAt, threadId });

        expect(await sweep(NOW)).toBe(2);

        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
        expect(await reminderOf("a2")).toBe(NOW);
    });

    it("sends a separate push for a later pause on the same thread", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });
        await insertRun({ approvalId: "a2", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 10 * MINUTE, threadId });

        await sweep(NOW);

        expect(await approvalPushes()).toHaveLength(2);
    });

    it("does not remind a request that is younger than four hours", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - 3 * HOUR, threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
        expect(await reminderOf("a1")).toBeUndefined();
    });

    it("does not remind a request older than the sweep window", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - APPROVAL_REMINDER_WINDOW_MS - MINUTE, threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
    });

    it("does not remind a request that was answered", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, status: "approved", threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
    });

    it("does not push a reminder for a question, which is answered in the chat, and still marks it", async () => {
        await insertThread();
        await insertRequest("q1", "askUser");
        await insertRun({ approvalId: "q1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(0);
        expect(await reminderOf("q1")).toBe(NOW);
    });

    it("does not push a reminder for a secret request", async () => {
        await insertThread();
        await insertRequest("s1", "requestSecret");
        await insertRun({ approvalId: "s1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(0);
    });

    it("still reminds a plain approval whose request is on the thread", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(1);
    });
});
