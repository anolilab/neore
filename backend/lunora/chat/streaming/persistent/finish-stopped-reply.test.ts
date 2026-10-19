/**
 * A stopped run saves the text it still owed its reply: into the pending row of its
 * step in flight, or as a new row for a continuation that has none. The chunks are
 * not read: each finished step is already its own saved message.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { finishStoppedReply } from "./library";

const OWNER = "user-owner";

let harness: ReturnType<typeof lunoraTest>;

const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

interface Row {
    _id: string;
    message: { content: unknown; role: string };
    order: number;
    status: string;
}

/**
 * A thread with a user prompt (order 1), a stream that wrote an earlier step's text, and
 * optionally the pending assistant row of the step in flight.
 */
const seed = async (status: "done" | "streaming" | "timeout", { pendingRow }: { pendingRow: boolean }) =>
    await run(async (context) => {
        const threadId = await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: OWNER });
        const promptId = await context.db.insert("messages", {
            message: { content: "hi", role: "user" },
            order: 1,
            status: "success",
            stepOrder: 0,
            text: "hi",
            threadId,
            tool: false,
            userId: OWNER,
        });
        const pendingId = pendingRow
            ? await context.db.insert("messages", {
                  message: { content: [], role: "assistant" },
                  order: 1,
                  status: "pending",
                  stepOrder: 1,
                  text: "",
                  threadId,
                  tool: false,
                  userId: OWNER,
              })
            : undefined;
        const streamId = await context.db.insert("persistentStreams", {
            expiresAt: Date.now() + 60_000,
            messageId: promptId,
            status,
            streamingConfig: { contentType: "text", model: "m" },
            threadId,
            userId: OWNER,
        });

        // The earlier step's text is in the stream, and is already saved as its own message.
        await context.db.insert("persistentChunks", { seq: 0, streamId, text: "Let me search. " });

        return { pendingId, promptId, streamId, threadId };
    });

const rowsOf = async (threadId: string): Promise<Row[]> =>
    await run(async (context) => {
        const { page } = await context.db.messages.findMany({ where: { threadId } });

        return page as Row[];
    });

const assistantRowsOf = async (threadId: string): Promise<Row[]> => {
    const rows = await rowsOf(threadId);

    return rows.filter((row) => row.message.role === "assistant");
};

/** The `status` of the row at `id`, read in its own run. */
const statusOf = async (id: string): Promise<unknown> =>
    await run(async (context) => {
        const row = await context.db.get(id);

        return (row as { status?: unknown } | null)?.status;
    });

const stop = (streamId: string, args: { continuation?: boolean; order?: number; pendingReasoning?: string; pendingText: string; promptMessageId: string }) =>
    run(
        async (context) =>
            await context.runMutation(finishStoppedReply, {
                continuation: args.continuation ?? false,
                order: args.order ?? 1,
                pendingReasoning: args.pendingReasoning ?? "",
                pendingText: args.pendingText,
                promptMessageId: args.promptMessageId,
                streamId,
            }),
    );

describe("finishStoppedReply", () => {
    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("completes the pending row with the owed text only, not the earlier step's chunks", async () => {
        const { pendingId, promptId, streamId, threadId } = await seed("done", { pendingRow: true });

        expect(await stop(streamId, { pendingText: "Answer.", promptMessageId: promptId })).toBe(true);

        const assistant = await assistantRowsOf(threadId);

        expect(assistant).toHaveLength(1);
        expect(assistant[0]?._id).toBe(pendingId);
        expect(assistant[0]?.status).toBe("success");
        expect(assistant[0]?.message.content).toStrictEqual([{ text: "Answer.", type: "text" }]);
        expect(await statusOf(threadId)).toBe("active");
    });

    it("a continuation with no pending row gets one new row at its own order, and nothing else is added", async () => {
        const { promptId, streamId, threadId } = await seed("done", { pendingRow: false });

        expect(await stop(streamId, { continuation: true, order: 2, pendingText: "Resumed.", promptMessageId: promptId })).toBe(true);

        const assistant = await assistantRowsOf(threadId);

        expect(assistant).toHaveLength(1);
        expect(assistant[0]?.order).toBe(2);
        expect(assistant[0]?.status).toBe("success");
        expect(assistant[0]?.message.content).toStrictEqual([{ text: "Resumed.", type: "text" }]);
    });

    it("with no owed text and no pending row, adds no row and still ends the thread's run", async () => {
        const { promptId, streamId, threadId } = await seed("done", { pendingRow: false });

        expect(await stop(streamId, { continuation: true, order: 2, pendingText: "", promptMessageId: promptId })).toBe(true);

        expect(await assistantRowsOf(threadId)).toHaveLength(0);
        expect(await statusOf(threadId)).toBe("active");
    });

    it("saves nothing for a stream that was not ended by a stop", async () => {
        const { pendingId, promptId, streamId, threadId } = await seed("timeout", { pendingRow: true });

        expect(await stop(streamId, { pendingText: "Answer.", promptMessageId: promptId })).toBe(false);

        const rows = await rowsOf(threadId);
        const pending = rows.find((row) => row._id === pendingId);

        expect(pending?.status).toBe("pending");
        expect(await statusOf(threadId)).toBe("running");
    });

    it("never saves a live stream", async () => {
        const { promptId, streamId } = await seed("streaming", { pendingRow: true });

        expect(await stop(streamId, { pendingText: "x", promptMessageId: promptId })).toBe(false);
    });

    it("refuses an owed text larger than a stored document", async () => {
        const { promptId, streamId } = await seed("done", { pendingRow: true });

        await expect(stop(streamId, { pendingText: "x".repeat(2_000_001), promptMessageId: promptId })).rejects.toThrow();
    });
});
