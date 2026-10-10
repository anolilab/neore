/**
 * `askUser`: the pause (the tool always asks, and its request is recorded like
 * any approval), answering and dismissing (one claim on the run's snapshot,
 * only for an `askUser` request), a repeat answer (a double submit or second
 * tab gets the first outcome back), and the resumed tool returning the answer.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../../schema";
import { ASK_USER_ANSWER_MAX } from "../tools/ask-user-constants";
import { claimAskUserAnswer, normalizeAskUserAnswer } from "./ask-user-claim";
import { collectApprovalRequestIds, collectAskUserApprovalIds } from "./tool-approval-claim";

type Harness = ReturnType<typeof lunoraTest>;

// The agent client's import graph does not load on its own in a unit test; the
// tool's DEFINITION is what is under test, so `createTool` hands it back as is.
vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});

const loadTool = async () => await import("../tools/ask-user");

interface ToolDefinition {
    execute: (context: unknown, input: unknown, options: unknown) => Promise<unknown>;
    needsApproval: unknown;
}

const OWNER = "owner-user";
const STRANGER = "other-user";

const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: true,
    toolNames: ["askUser", "webSearch"],
};

const request = (approvalId: string, toolName: string) => {
    return {
        content: [
            { input: { choices: ["Red", "Blue"], question: "Which colour?" }, toolCallId: `call-${approvalId}`, toolName, type: "tool-call" },
            { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
        ],
        role: "assistant",
    };
};

let harness: Harness;
let threadId: string;

const insertMessage = async (order: number, message: unknown) =>
    await harness.run(
        async (ctx: any) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder: 0, threadId, tool: true, userId: OWNER }),
    );

const insertRun = async (approvalId: string) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", { approvalId, config: CONFIG, createdAt: Date.now(), status: "pending", threadId, userId: OWNER }),
    );

const reply = async (answer: string | null, options: { approvalId?: string; callerId?: string } = {}) =>
    await harness.run(
        async (ctx: any) =>
            await claimAskUserAnswer(ctx, {
                approvalId: options.approvalId ?? "ask-1",
                callerId: options.callerId ?? OWNER,
                reply: answer === null ? { kind: "dismiss" } : { answer, kind: "answer" },
                threadId: threadId as never,
            }),
    );

const statuses = async () =>
    await harness.run(async (ctx: any) => {
        const runs: { status: string }[] = await ctx.db.query("toolApprovalRuns").collect();

        return runs.map((run) => run.status);
    });

const ANSWER_WITH = /Answer with/u;
const NOT_FOUND = /not found/iu;
const NOT_A_QUESTION = /not a question/u;

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

    await insertMessage(0, { content: "paint it", role: "user" });
    await insertMessage(1, request("ask-1", "askUser"));
    await insertRun("ask-1");
});

afterEach(() => {
    harness.close();
});

describe("askUser pause", () => {
    it("always asks, so the run stops on a request whatever the permission layer says", async () => {
        const { default: askUserTool } = await loadTool();

        expect((askUserTool as unknown as ToolDefinition).needsApproval).toBe(true);
    });

    it("records the question as a pending request of the run", () => {
        expect(collectApprovalRequestIds([{ message: request("ask-1", "askUser") }])).toStrictEqual(["ask-1"]);
    });

    it("tells a question apart from an ordinary approval request", () => {
        const saved = [{ message: request("ask-1", "askUser") }, { message: request("other-1", "mcp_Files__delete") }];

        expect(collectAskUserApprovalIds(saved, "askUser")).toStrictEqual(["ask-1"]);
    });
});

describe("claimAskUserAnswer", () => {
    it("answering approves the call once and carries the trimmed answer", async () => {
        const claim = await reply("  Blue  ");

        expect(claim).toMatchObject({ answer: "Blue", kind: "claimed", ownerId: OWNER, toolName: "askUser" });
        expect(await statuses()).toStrictEqual(["approved"]);
    });

    it("dismissing denies the call", async () => {
        const claim = await reply(null);

        expect(claim).toMatchObject({ kind: "claimed" });
        expect(claim).not.toHaveProperty("answer");
        expect(await statuses()).toStrictEqual(["denied"]);
    });

    it("a second answer (double submit, second tab, redelivery) gets the first outcome back", async () => {
        await reply("Red");

        expect(await reply("Blue")).toMatchObject({ kind: "already-resolved", status: "approved" });
        expect(await statuses()).toStrictEqual(["approved"]);
    });

    it("refuses an empty or oversized answer without claiming", async () => {
        await expect(reply(" ".repeat(3))).rejects.toThrow(ANSWER_WITH);
        await expect(reply("x".repeat(ASK_USER_ANSWER_MAX + 1))).rejects.toThrow(ANSWER_WITH);
        expect(await statuses()).toStrictEqual(["pending"]);
    });

    it("refuses anyone but the owner", async () => {
        await expect(reply("Blue", { callerId: STRANGER })).rejects.toThrow(NOT_FOUND);
        expect(await statuses()).toStrictEqual(["pending"]);
    });

    it("refuses to answer an approval request for another tool", async () => {
        await insertMessage(2, { content: "and delete it", role: "user" });
        await insertMessage(3, request("other-1", "mcp_Files__delete"));
        await insertRun("other-1");

        await expect(reply("yes", { approvalId: "other-1" })).rejects.toThrow(NOT_A_QUESTION);
    });
});

describe("resumed askUser", () => {
    it("returns the user's answer as the tool result", async () => {
        const { createAnsweredAskUserTool } = await loadTool();
        const answered = createAnsweredAskUserTool("Blue") as unknown as ToolDefinition;

        expect(answered.needsApproval).toBe(true);
        expect(await answered.execute({}, { question: "Which colour?" }, { toolCallId: "call-ask-1" })).toStrictEqual({
            answer: "Blue",
            answered: true,
        });
    });

    it("normalises answers", () => {
        expect(normalizeAskUserAnswer(" ok ")).toBe("ok");
        expect(normalizeAskUserAnswer("")).toBeUndefined();
    });
});
