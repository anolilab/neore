/**
 * A chunk write refused with CONFLICT (the stream was ended by a sidebar stop) stops
 * the pipe with the text the reply still owes: what was written since the last
 * finished step, and what was buffered but not written.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { isStreamStopped, isStreamWriteRefused, originalWriteError, pipeToPersistentChunks } from "./persist-stream";

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

/** Two steps, each opened by a `start-step` part, as a steered run streams them. */
async function* steps() {
    yield { type: "start-step" };
    yield { text: "Reading.", type: "text-delta" };
    yield { type: "finish-step" };
    yield { type: "start-step" };
    yield { text: "The other one", type: "text-delta" };
}

/** A step that ends cleanly, then a model call that fails before its step starts. */
async function* failing() {
    yield { type: "start-step" };
    yield { text: "Reading.", type: "text-delta" };
    yield { type: "finish-step" };
    yield { error: new Error("provider down"), type: "error" };
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

    it("a refusal at a finished step's flush owes nothing, since the agent saves that step itself", async () => {
        const { ctx } = ctxAccepting(1);

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. ", "Two", "finish-step"])).catch((error_: unknown) => error_);

        expect(isStreamWriteRefused(error)).toBe(true);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "" });
    });

    it("rethrows a non-refusal failure at a finished step's flush as it was", async () => {
        const boom = new Error("database down");
        let calls = 0;
        const ctx = {
            runMutation: async () => {
                calls += 1;

                if (calls > 1) {
                    throw boom;
                }
            },
        };

        await expect(pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. ", "Two", "finish-step"]))).rejects.toBe(boom);
    });

    it("marks where the reply continues below a steered message, after the step before it", async () => {
        const chunks: { restart?: boolean; text: string }[] = [];
        const ctx = {
            runMutation: async (_ref: unknown, args: { restart?: boolean; text: string }) => {
                chunks.push({ ...(args.restart && { restart: true }), text: args.text });
            },
        };
        // Delivered at the boundary before the second step only.
        const steered = [false, true];

        const piped = await pipeToPersistentChunks(ctx as never, "stream-1", steps(), { steeredBefore: () => steered.shift() ?? false });

        expect(chunks).toStrictEqual([{ text: "Reading." }, { restart: true, text: "" }]);
        expect(piped.pending).toStrictEqual({ reasoning: "", text: "The other one" });
    });

    it("marks the cut before the error when the model call after a steered message fails before its step starts", async () => {
        const chunks: { restart?: boolean; text: string }[] = [];
        const ctx = {
            runMutation: async (_ref: unknown, args: { restart?: boolean; text: string }) => {
                chunks.push({ ...(args.restart && { restart: true }), text: args.text });
            },
        };
        const steered = [false, true];

        await expect(pipeToPersistentChunks(ctx as never, "stream-1", failing(), { steeredBefore: () => steered.shift() ?? false })).rejects.toThrow(
            "provider down",
        );
        expect(chunks).toStrictEqual([{ text: "Reading." }, { restart: true, text: "" }]);
    });

    it("marks every cut still owed when the model call fails before its step starts", async () => {
        const chunks: { restart?: boolean; text: string }[] = [];
        const ctx = {
            runMutation: async (_ref: unknown, args: { restart?: boolean; text: string }) => {
                chunks.push({ ...(args.restart && { restart: true }), text: args.text });
            },
        };
        // Two deliveries made while the pipe was still on the first step.
        const steered = [false, true, true];

        await expect(pipeToPersistentChunks(ctx as never, "stream-1", failing(), { steeredBefore: () => steered.shift() ?? false })).rejects.toThrow(
            "provider down",
        );
        expect(chunks.filter((chunk) => chunk.restart)).toHaveLength(2);
    });

    it("owes nothing when a stop refuses the restart marker: the steps before it are saved", async () => {
        const { ctx, written } = ctxAccepting(1);
        const steered = [false, true];

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", steps(), { steeredBefore: () => steered.shift() ?? false }).catch(
            (error_: unknown) => error_,
        );

        expect(written).toStrictEqual(["Reading."]);
        expect(isStreamWriteRefused(error)).toBe(true);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "" });
    });

    it("owes only the text after the restart marker when a stop comes later: the steps before it were saved", async () => {
        // "Reading." and the marker are accepted; the flush of the continuation is the refused write.
        const { ctx, written } = ctxAccepting(2);
        const steered = [false, true];

        async function* continued() {
            yield* steps();
            yield { text: " Next.", type: "text-delta" };
        }

        const error = await pipeToPersistentChunks(ctx as never, "stream-1", continued(), { steeredBefore: () => steered.shift() ?? false }).catch(
            (error_: unknown) => error_,
        );

        expect(written).toStrictEqual(["Reading.", ""]);
        expect(isStreamWriteRefused(error)).toBe(true);
        expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "The other one Next." });
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

    describe("a stop during a quiet stretch (a long tool step)", () => {
        /** A context that accepts writes and answers the stream's status from `status.current`. */
        const ctxWithStatus = (status: { current: string }) => {
            const polls: number[] = [];
            const ctx = {
                runMutation: async () => undefined,
                runQuery: async () => {
                    polls.push(Date.now());

                    return status.current;
                },
            };

            return { ctx, polls };
        };

        /** A model stream that writes some text, then goes quiet inside a tool step until `signal` aborts. */
        async function* quietAfterText(signal: AbortSignal, ran: { toolSignalAborted: boolean }) {
            yield { text: "Let me look. ", type: "text-delta" };
            await new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), { once: true });
            });
            ran.toolSignalAborted = signal.aborted;
        }

        it("is found by polling while no part arrives, with the text it owed", async () => {
            const status = { current: "streaming" };
            const { ctx } = ctxWithStatus(status);
            const tool = new AbortController();
            const ran = { toolSignalAborted: false };
            const piping = pipeToPersistentChunks(ctx as never, "stream-1", quietAfterText(tool.signal, ran), { stopPollMs: 10 }).catch(
                (error: unknown) => error,
            );

            status.current = "done";

            const error = await piping;

            expect(isStreamWriteRefused(error)).toBe(true);
            expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "Let me look. " });

            // The caller's `endStoppedRun` aborts next; the quiet step then ends, it was not left running.
            tool.abort();
            await vi.waitFor(() => expect(ran.toolSignalAborted).toBe(true));
        });

        it("finds a stop while the model streams parts that write no chunk, such as a tool's input", async () => {
            const { ctx } = ctxWithStatus({ current: "done" });
            const closed = { value: false };

            async function* toolInput() {
                yield { text: "Let me look. ", type: "text-delta" };

                while (!closed.value) {
                    yield { type: "tool-input-delta" };
                    await new Promise((resolve) => {
                        setTimeout(resolve, 2);
                    });
                }
            }

            const error = await pipeToPersistentChunks(ctx as never, "stream-1", toolInput(), { stopPollMs: 20 }).catch((error_: unknown) => error_);

            closed.value = true;

            expect(isStreamWriteRefused(error)).toBe(true);
            expect((error as { pending: unknown }).pending).toStrictEqual({ reasoning: "", text: "Let me look. " });
        });

        it("reads no further part once a stop was found while a chunk write was still open", async () => {
            const polls: number[] = [];
            const write = { release: () => {} };
            const reads = { count: 0 };
            const ctx = {
                runMutation: async () =>
                    await new Promise<void>((resolve) => {
                        write.release = resolve;
                    }),
                runQuery: async () => {
                    polls.push(Date.now());

                    return "done";
                },
            };
            const source = {
                [Symbol.asyncIterator]: () => {
                    return {
                        next: async () => {
                            reads.count += 1;

                            return reads.count === 1
                                ? { done: false, value: { text: "One. ", type: "text-delta" } }
                                : { done: false, value: { text: "Two. ", type: "text-delta" } };
                        },
                    };
                },
            };
            const piping = pipeToPersistentChunks(ctx as never, "stream-1", source, { stopPollMs: 10 }).catch((error_: unknown) => error_);

            await vi.waitFor(() => expect(polls.length).toBeGreaterThan(0));
            await new Promise((resolve) => {
                setTimeout(resolve, 5);
            });
            write.release();

            const error = await piping;

            expect(isStreamWriteRefused(error)).toBe(true);
            expect(reads.count).toBe(1);
        });

        it("closes the model stream when a chunk write fails for a reason other than a stop", async () => {
            const boom = new Error("database down");
            const ctx = {
                runMutation: async () => {
                    throw boom;
                },
                runQuery: async () => "streaming",
            };
            const closed = { value: false };
            const source = {
                [Symbol.asyncIterator]: () => {
                    return {
                        next: async () => {
                            return { done: false, value: { text: "One. ", type: "text-delta" } };
                        },
                        return: async () => {
                            closed.value = true;

                            return { done: true as const, value: undefined };
                        },
                    };
                },
            };

            await expect(pipeToPersistentChunks(ctx as never, "stream-1", source, { stopPollMs: 10 })).rejects.toBe(boom);
            expect(closed.value).toBe(true);
        });

        it("does not poll while parts keep arriving, nor after the stream ended", async () => {
            const { ctx, polls } = ctxWithStatus({ current: "done" });

            await pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. ", "Two. "]), { stopPollMs: 10 });
            await new Promise((resolve) => {
                setTimeout(resolve, 50);
            });

            expect(polls).toHaveLength(0);
        });

        it("a stream that ends normally is not reported as stopped, whatever its row says afterwards", async () => {
            const status = { current: "streaming" };
            const { ctx } = ctxWithStatus(status);
            const piped = await pipeToPersistentChunks(ctx as never, "stream-1", parts(["One. "]), { stopPollMs: 10 });

            status.current = "done";
            await new Promise((resolve) => {
                setTimeout(resolve, 30);
            });

            expect(piped.pending).toStrictEqual({ reasoning: "", text: "" });
        });

        it("a failed status read is not a stop", async () => {
            const ctx = {
                runMutation: async () => undefined,
                runQuery: async () => {
                    throw new Error("shard busy");
                },
            };

            await expect(isStreamStopped(ctx as never, "stream-1")).resolves.toBe(false);
        });
    });
});
