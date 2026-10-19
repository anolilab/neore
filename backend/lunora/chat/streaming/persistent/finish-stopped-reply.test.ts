/**
 * A sidebar stop saves what the stopped run had written as the assistant reply:
 * the pending row for the prompt is completed in place, the thread goes `active`,
 * and nothing is saved for a stream that was not ended by a stop.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { finishStoppedReply } from "./library";

const OWNER = "user-owner";

let harness: ReturnType<typeof lunoraTest>;

const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

/** A thread with a user prompt, a pending assistant row for it, and a stream with chunks already written. */
const seed = async (status: "done" | "streaming" | "timeout") =>
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
        const pendingId = await context.db.insert("messages", {
            message: { content: [], role: "assistant" },
            order: 1,
            status: "pending",
            stepOrder: 1,
            text: "",
            threadId,
            tool: false,
            userId: OWNER,
        });
        const streamId = await context.db.insert("persistentStreams", {
            expiresAt: Date.now() + 60_000,
            messageId: promptId,
            status,
            streamingConfig: { contentType: "text", model: "m" },
            threadId,
            userId: OWNER,
        });

        await context.db.insert("persistentChunks", { seq: 0, streamId, text: "Hello " });
        await context.db.insert("persistentChunks", { seq: 1, streamId, text: "wor" });

        return { pendingId, streamId, threadId };
    });

const rowsOf = async (threadId: string) =>
    await run(async (context) => {
        const { page } = await context.db.messages.findMany({ where: { threadId } });

        return page as { _id: string; message: { content: unknown; role: string }; status: string }[];
    });

/** The `status` of the thread or stream row at `id`, read in its own run. */
const statusOf = async (id: string): Promise<unknown> =>
    await run(async (context) => {
        const row = await context.db.get(id);

        return (row as { status?: unknown } | null)?.status;
    });

describe("finishStoppedReply", () => {
    beforeEach(() => {
        harness = lunoraTest(schema as never);
    });

    afterEach(() => {
        harness.close();
    });

    it("completes the pending assistant row with the written and the unwritten text, and reactivates the thread", async () => {
        const { pendingId, streamId, threadId } = await seed("done");

        const saved = await run(async (context) => await context.runMutation(finishStoppedReply, { pendingReasoning: "", pendingText: "ld.", streamId }));

        expect(saved).toBe(true);

        const rows = await rowsOf(threadId);
        const assistant = rows.filter((row) => row.message.role === "assistant");
        const [reply] = assistant;

        expect(assistant).toHaveLength(1);
        expect(reply?._id).toBe(pendingId);
        expect(reply?.status).toBe("success");
        expect(reply?.message.content).toStrictEqual([{ text: "Hello world.", type: "text" }]);
        expect(await statusOf(threadId)).toBe("active");
        expect(await statusOf(streamId)).toBe("done");
    });

    it("saves nothing for a stream that was not ended by a stop", async () => {
        const { pendingId, streamId, threadId } = await seed("timeout");

        const saved = await run(async (context) => await context.runMutation(finishStoppedReply, { pendingReasoning: "", pendingText: "ld.", streamId }));

        expect(saved).toBe(false);

        const rows = await rowsOf(threadId);
        const pending = rows.find((row) => row._id === pendingId);

        expect(pending?.status).toBe("pending");
        expect(await statusOf(threadId)).toBe("running");
    });

    it("never saves a live stream", async () => {
        const { streamId } = await seed("streaming");

        const saved = await run(async (context) => await context.runMutation(finishStoppedReply, { pendingReasoning: "", pendingText: "x", streamId }));

        expect(saved).toBe(false);
    });
});
