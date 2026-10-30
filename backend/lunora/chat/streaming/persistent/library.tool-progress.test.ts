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

describe("tool progress in the persisted body", () => {
    const body = async () =>
        (await harness.run(async (context: any) => await context.runQuery(getStreamText, { streamId }))) as { text: string; toolProgress?: unknown[] };

    it("returns the latest report of each call that has not ended, in the order they first reported", async () => {
        await write({ text: "Looking." });
        await write({ text: "", toolProgress: { ...tool, message: "Page 1", progress: 1, total: 4 } });
        await write({ text: "", toolProgress: { ...tool, progress: 7, toolCallId: "call_2" } });
        await write({ text: "", toolProgress: { ...tool, message: "Page 2", progress: 2, total: 4 } });
        await write({ text: "", toolProgress: { ...tool, ended: true, toolCallId: "call_2" } });

        const { text, toolProgress } = await body();

        expect(text).toBe("Looking.");
        expect(toolProgress).toStrictEqual([{ ...tool, message: "Page 2", progress: 2, total: 4 }]);
    });

    it("returns none when no call reported, or every call ended", async () => {
        await write({ text: "Hello" });

        const before = await body();

        expect(before.toolProgress).toBeUndefined();

        await write({ text: "", toolProgress: { ...tool, progress: 1 } });
        await write({ text: "", toolProgress: { ...tool, ended: true } });

        const after = await body();

        expect(after.toolProgress).toBeUndefined();
    });

    it("forgets the calls of a reply that restarted below a steered message", async () => {
        await write({ text: "", toolProgress: { ...tool, progress: 1 } });
        await write({ restart: true, text: "Again." });

        const result = await body();

        expect(result.toolProgress).toBeUndefined();
    });

    it("returns none once the stream is over", async () => {
        await write({ text: "", toolProgress: { ...tool, progress: 1 } });
        await write({ final: true, text: "Done." });

        const result = await body();

        expect(result.toolProgress).toBeUndefined();
    });
});
