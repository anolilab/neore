/**
 * A chunk write refused with CONFLICT (the stream was ended by a sidebar stop) stops
 * the pipe with the text the reply still owes: what was written since the last
 * finished step, and what was buffered but not written.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it } from "vitest";

import { isStreamWriteRefused, originalWriteError, pipeToPersistentChunks } from "./persist-stream";

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

/** Parts of a model stream: a string is a text delta, `"finish-step"` ends a step. */
async function* parts(items: (string | "finish-step")[]) {
    for (const item of items) {
        yield item === "finish-step" ? { type: "finish-step" } : { text: item, type: "text-delta" };
    }
}

describe(pipeToPersistentChunks, () => {
    it("stops at a refused write and owes the whole text, since no step has finished", async () => {
        const { ctx, written } = ctxAccepting(1);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. ", "Two. ", "Three. "])).catch((error_: unknown) => error_);

        expect(isStreamWriteRefused(error)).toBe(true);
        expect(written).toStrictEqual(["One. "]);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "One. Two. " });
    });

    it("after a finished step, owes only the text since that step, not the step's own text", async () => {
        // The first step's text is written and then saved as its own message by the agent.
        const { ctx } = ctxAccepting(1);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["Let me search. ", "finish-step", "Answer."])).catch(
            (error_: unknown) => error_,
        );

        expect(isStreamWriteRefused(error)).toBe(true);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "Answer." });
    });

    it("keeps the original write error as the cause of a refusal", async () => {
        const { ctx } = ctxAccepting(0);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["Hi. "])).catch((error_: unknown) => error_);

        expect(originalWriteError(error)).toBeInstanceOf(LunoraError);
        expect((originalWriteError(error) as LunoraError).code).toBe("CONFLICT");
    });

    it("on a normal end, reports the text since the last finished step as unsaved", async () => {
        const { ctx } = ctxAccepting(10);

        const piped = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["Let me search. ", "finish-step", "Answer."]));

        expect(piped.unsaved).toStrictEqual({ reasoning: "", text: "Answer." });
        expect(piped.pending).toStrictEqual({ reasoning: "", text: "" });
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
