/**
 * A long reply writes more chunks than one page holds. The text and the activity are read from every page, so the reply's
 * last chunk is still there.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../../../schema";
import { createStream, getStreamText } from "./library";

let harness: ReturnType<typeof lunoraTest>;
let streamId: string;

const CHUNKS = 300;

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

describe("reading a long reply", () => {
    it("reads the reply's text from every page, so its last chunk is included", async () => {
        await harness.run(async (context: any) => {
            await context.db.patch("persistentStreams", streamId, { status: "streaming" });

            for (let seq = 0; seq < CHUNKS; seq += 1) {
                await context.db.insert("persistentChunks", { seq, streamId, text: seq === CHUNKS - 1 ? "END" : "." });
            }
        });

        const result = (await harness.run(async (context: any) => await context.runQuery(getStreamText, { streamId }))) as { text: string };

        expect(result.text.endsWith("END")).toBe(true);
        expect(result.text).toHaveLength(CHUNKS - 1 + "END".length);
    });
});
