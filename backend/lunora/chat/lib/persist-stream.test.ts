/**
 * A chunk write refused with CONFLICT (the stream was ended by a sidebar stop) stops
 * the pipe with the text it had buffered, so the stopped reply keeps it.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { isStreamWriteRefused, pipeToPersistentChunks } from "./persist-stream";

/** A fake action context: the first `accepted` chunk writes succeed, the next one is refused as a stop. */
const ctxAccepting = (accepted: number) => {
    const written: string[] = [];
    const ctx = {
        runMutation: async (_ref: unknown, args: { text: string }) => {
            if (written.length >= accepted) {
                throw new LunoraError("CONFLICT", "Stream is not streaming; did it timeout?");
            }

            written.push(args.text);
        },
    };

    return { ctx, written };
};

async function* parts(texts: string[]) {
    for (const text of texts) {
        yield { text, type: "text-delta" };
    }
}

describe(pipeToPersistentChunks, () => {
    it("stops at a refused write and carries the text that was buffered but not written", async () => {
        const { ctx, written } = ctxAccepting(1);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. ", "Two. ", "Three. "])).catch((error_: unknown) => error_);

        expect(isStreamWriteRefused(error)).toBe(true);
        expect(written).toStrictEqual(["One. "]);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "Two. " });
    });

    it("rethrows any other write failure as it was", async () => {
        const boom = new Error("database down");
        const ctx = {
            runMutation: async () => {
                throw boom;
            },
        };

        await expect(pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. "]))).rejects.toBe(boom);
    });
});
