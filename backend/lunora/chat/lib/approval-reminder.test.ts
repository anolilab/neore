/**
 * The four-hour reminder for a pending approval: one push per pause, once per approval, and only for requests in the window.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runInShard } from "../../lib/shard-context";
import schema from "../../schema";
import { ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
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

/** The order each inserted assistant turn takes, so each request is on a later row of the thread. */
let order = 0;

const insertThread = async (): Promise<void> => {
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Owner thread", userId: "u1" }))) as string;
};

const insertRun = async (row: { approvalId: string; createdAt: number; pauseId?: string; status?: "approved" | "denied" | "pending"; threadId: string }) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", {
                config: CONFIG,
                status: "pending",
                userId: "u1",
                ...row,
            }),
    );

// The assistant turn that asked for the request, as the run saves it, so the sweep can read what kind of request it is.
const insertRequest = async (approvalId: string, toolName: string) => {
    order += 1;

    return await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: {
                    content: [
                        { input: {}, toolCallId: `call-${approvalId}`, toolName, type: "tool-call" },
                        { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
                    ],
                    role: "assistant",
                },
                order,
                status: "success",
                stepOrder: 0,
                threadId,
                tool: true,
                userId: "u1",
            }),
    );
};

// Run as the owner's shard, where a notification for the owner is written here rather than handed to another shard.
const sweep = async (now: number) => await harness.run(async (ctx: any) => await runInShard("u1", () => remindPendingApprovals(ctx, now)));

const pushesOfType = async (type: string) =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("notifications").collect();

        return rows.filter((row: { type: string }) => row.type === type);
    });

const approvalPushes = async () => await pushesOfType("tool_approval");

const reminderOf = async (approvalId: string) =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("toolApprovalRuns").collect();

        return rows.find((row: { approvalId: string }) => row.approvalId === approvalId)?.reminderSentAt;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
    order = 0;
});

afterEach(() => {
    harness.close();
});

const DUE = NOW - APPROVAL_REMINDER_AFTER_MS - 30 * MINUTE;

describe("the four-hour approval reminder", () => {
    it("reminds a request that has waited four hours, with one push", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(1);

        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
    });

    it("sends one reminder per approval, not one per sweep", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });

        await sweep(NOW);
        const later = await sweep(NOW + MINUTE);

        expect(later).toBe(0);
        expect(await approvalPushes()).toHaveLength(1);
    });

    it("reminds a pause that waits on a question with a generic push of that kind", async () => {
        await insertThread();
        await insertRequest("q1", ASK_USER_TOOL_NAME);
        await insertRun({ approvalId: "q1", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(1);

        const questions = await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("notifications").collect();

            return rows.filter((row: { type: string }) => row.type === "ask_user");
        });

        expect(questions).toHaveLength(1);
        expect(await reminderOf("q1")).toBe(NOW);
    });

    it("reminds a request asked exactly four hours before the sweep", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(1);
    });

    it("keeps two pauses asked in the same millisecond apart: the latest is pushed, the earlier one is marked and not pushed", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRequest("a2", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, pauseId: "a1", threadId });
        await insertRun({ approvalId: "a2", createdAt: DUE, pauseId: "a2", threadId });

        await sweep(NOW);

        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
        expect(await reminderOf("a2")).toBe(NOW);
    });

    it("sends one push for the several approvals one pause asked for, and marks each of them", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRequest("a2", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });
        await insertRun({ approvalId: "a2", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(2);

        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
        expect(await reminderOf("a2")).toBe(NOW);
    });

    it("pushes for the latest pause on a thread, and not for an earlier one the thread has moved past", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRequest("a2", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });
        await insertRun({ approvalId: "a2", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - 10 * MINUTE, threadId });

        expect(await sweep(NOW)).toBe(2);

        // a1's request sits under a newer turn (a2's), so it is superseded: marked, not pushed.
        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("a1")).toBe(NOW);
        expect(await reminderOf("a2")).toBe(NOW);
    });

    it("does not remind a request that is younger than four hours", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: NOW - 3 * HOUR, threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
        expect(await reminderOf("a1")).toBeUndefined();
    });

    it("does not remind a request older than the sweep window", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: NOW - APPROVAL_REMINDER_AFTER_MS - APPROVAL_REMINDER_WINDOW_MS - MINUTE, threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
    });

    it("does not remind a request that was answered", async () => {
        await insertThread();
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "a1", createdAt: DUE, status: "approved", threadId });

        expect(await sweep(NOW)).toBe(0);
        expect(await approvalPushes()).toHaveLength(0);
    });

    it("pushes a generic reminder for a secret request, and no approval push", async () => {
        await insertThread();
        await insertRequest("s1", "requestSecret");
        await insertRun({ approvalId: "s1", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(0);
        expect(await pushesOfType("secret_request")).toHaveLength(1);
    });

    it("pushes for an approval that follows a question in the same pause, and marks both rows", async () => {
        await insertThread();
        await insertRequest("q1", "askUser");
        await insertRequest("a1", "webSearch");
        await insertRun({ approvalId: "q1", createdAt: DUE, threadId });
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(2);
        expect(await approvalPushes()).toHaveLength(1);
        expect(await reminderOf("q1")).toBe(NOW);
        expect(await reminderOf("a1")).toBe(NOW);
    });

    it("does not push for a request the latest turn no longer holds, and marks it so the sweep moves on", async () => {
        await insertThread();
        await insertRun({ approvalId: "a1", createdAt: DUE, threadId });

        expect(await sweep(NOW)).toBe(1);
        expect(await approvalPushes()).toHaveLength(0);
        expect(await reminderOf("a1")).toBe(NOW);
    });

    it("reaches every due approval on a shard with more than one batch of them", async () => {
        await insertThread();

        for (let index = 0; index < 150; index += 1) {
            await insertRequest(`b${index}`, "webSearch");
            await insertRun({ approvalId: `b${index}`, createdAt: DUE, threadId });
        }

        expect(await sweep(NOW)).toBe(150);
        expect(await reminderOf("b149")).toBe(NOW);
        expect(await approvalPushes()).toHaveLength(1);
    });
});
