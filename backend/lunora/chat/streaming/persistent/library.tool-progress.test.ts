/**
 * An MCP tool call's progress rides the stream as a chunk with a `toolProgress` field and no text.
 * `getChunksAfter`'s output validator rejects undeclared keys, so this reads the chunk back through it.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { addChunk, createStream, getChunksAfter, getStreamText } from "./library";

let harness: ReturnType<typeof lunoraTest>;
let streamId: string;

const tool = { serverName: "Docs", toolCallId: "call_1", toolName: "index" };

const write = async (args: Record<string, unknown>) =>
    await harness.run(async (context: any) => await context.runMutation(addChunk, { final: false, streamId, ...args }));

const read = async (afterIndex = 0) =>
    (await harness.run(async (context: any) => await context.runQuery(getChunksAfter, { afterIndex, streamId }))) as {
        chunks: { text: string; toolProgress?: unknown }[];
        status: string;
        totalChunks: number;
    };

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    await harness.run(async (context: any) => {
        const threadId = await context.db.insert("threads", { model: "m", status: "running", title: "t", userId: "u1" });

        streamId = await context.runMutation(createStream, { messageId: "m1", streamingConfig: { contentType: "text", model: "m" }, threadId, userId: "u1" });
    });
});

afterEach(() => {
    harness.close();
});

describe("tool progress chunks", () => {
    it("relays a report and its end, in order with the reply's text", async () => {
        await write({ text: "Looking." });
        await write({ text: "", toolProgress: { ...tool, message: "Page 1", progress: 1, total: 4 } });
        await write({ text: "", toolProgress: { ...tool, progress: 2 } });
        await write({ text: "", toolProgress: { ...tool, ended: true } });

        const { chunks, totalChunks } = await read();

        expect(totalChunks).toBe(4);
        expect(chunks.map((chunk) => chunk.toolProgress)).toStrictEqual([
            undefined,
            { ...tool, message: "Page 1", progress: 1, total: 4 },
            { ...tool, progress: 2 },
            { ...tool, ended: true },
        ]);
    });

    it("leaves the reply's text and the stream's status as they were", async () => {
        await write({ text: "Hello" });
        await write({ text: "", toolProgress: { ...tool, progress: 1 } });
        await write({ final: true, text: " there" });

        const body = (await harness.run(async (context: any) => await context.runQuery(getStreamText, { streamId }))) as { status: string; text: string };

        expect(body.text).toBe("Hello there");
        expect(body.status).toBe("done");
    });

    it("refuses a progress write once the stream is over, which the writer swallows", async () => {
        await write({ final: true, text: "Done." });

        await expect(write({ text: "", toolProgress: { ...tool, progress: 1 } })).rejects.toThrow();
    });
});
