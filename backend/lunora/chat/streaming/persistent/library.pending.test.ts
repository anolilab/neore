/**
 * A run that pauses on an approval or a question ends its stream `done`, so a reader that asks
 * (`withPendingRequest`) is told the reply is not finished: a person has to answer first.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { addChunk, createStream, getChunksAfter } from "./library";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;
let streamId: string;

const config = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "m",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: [],
};

const message = async (order: number, content: Record<string, unknown>) =>
    await harness.run(
        async (context: any) =>
            await context.db.insert("messages", { message: content, order, status: "success", stepOrder: 0, text: "", threadId, tool: false, userId: "u1" }),
    );

const pauseOn = async (toolName: string, input: Record<string, unknown>) => {
    await message(0, { content: "hi", role: "user" });
    await message(1, {
        content: [
            { input, toolCallId: "call1", toolName, type: "tool-call" },
            { approvalId: "ap1", toolCallId: "call1", type: "tool-approval-request" },
        ],
        role: "assistant",
    });
};

const record = async (createdAt: number, status: "approved" | "pending" = "pending") =>
    await harness.run(
        async (context: any) => await context.db.insert("toolApprovalRuns", { approvalId: "ap1", config, createdAt, status, threadId, userId: "u1" }),
    );

const finish = async () => await harness.run(async (context: any) => await context.runMutation(addChunk, { final: true, streamId, text: "Checking." }));

const read = async (withPendingRequest?: boolean) =>
    (await harness.run(
        async (context: any) =>
            await context.runQuery(getChunksAfter, { afterIndex: 0, streamId, ...(withPendingRequest !== undefined && { withPendingRequest }) }),
    )) as { pendingRequest?: unknown; status: string };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    await harness.run(async (context: any) => {
        threadId = await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: "u1" });
        streamId = await context.runMutation(createStream, { messageId: "m1", streamingConfig: { contentType: "text", model: "m" }, threadId, userId: "u1" });
    });
});

afterEach(() => {
    harness.close();
});

describe("getChunksAfter pendingRequest", () => {
    it("reports an askUser question the run paused on, with its text", async () => {
        await pauseOn("askUser", { question: "Which environment?" });
        await record(Date.now() + 1);
        await finish();

        expect(await read(true)).toMatchObject({
            pendingRequest: { question: "Which environment?", toolCallId: "call1", toolName: "askUser" },
            status: "done",
        });
    });

    it("reports a tool approval by tool name, with no question", async () => {
        await pauseOn("webSearch", { query: "x" });
        await record(Date.now() + 1);
        await finish();

        const { pendingRequest } = await read(true);

        expect(pendingRequest).toStrictEqual({ toolCallId: "call1", toolName: "webSearch" });
    });

    it("says nothing unless asked, and nothing before the stream is done", async () => {
        await pauseOn("askUser", { question: "Which?" });
        await record(Date.now() + 1);

        expect(await read(true)).not.toHaveProperty("pendingRequest");
        await finish();
        expect(await read()).not.toHaveProperty("pendingRequest");
        expect(await read(false)).not.toHaveProperty("pendingRequest");
    });

    it("ignores a request from an earlier turn and one already answered", async () => {
        await pauseOn("askUser", { question: "Which?" });
        await record(1);
        await finish();

        expect(await read(true)).not.toHaveProperty("pendingRequest");

        await harness.run(async (context: any) => {
            const row = await context.db.toolApprovalRuns.findFirst({ where: { approvalId: "ap1" } });

            await context.db.patch(row._id, { createdAt: Date.now() + 1, status: "approved" });
        });

        expect(await read(true)).not.toHaveProperty("pendingRequest");
    });
});
