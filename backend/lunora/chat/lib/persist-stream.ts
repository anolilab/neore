/**
 * Pipes an AI SDK `fullStream` into `persistentChunks`, the table the gateway
 * polls and the client's streaming placeholder reads.
 *
 * Text and reasoning are buffered and flushed at sentence delimiters (and at the
 * reasoning → answer boundary), with two exceptions that bound what a reader
 * waits for: the FIRST delta is written at once — it is the user's
 * time-to-first-token, and a long opening sentence used to hold it back until
 * its full stop — and a buffer older than {@link MAX_FLUSH_INTERVAL_MS} is
 * written whatever it ends with, so text without sentence punctuation (code,
 * tables, CJK) still streams instead of landing in one piece at the end. The
 * FINAL chunk is not written here — the caller decides when the stream is
 * done, because the interactive run has more to do before it may close the
 * stream.
 *
 * A stream `error` part is not swallowed the way `textStream` swallowed it: the
 * stream is drained, whatever text arrived is flushed, and a
 * {@link StreamFailedError} is thrown so the caller's catch writes the error
 * chunk and marks the thread failed.
 *
 * A sidebar stop ends the stream row, which a run notices on its next chunk write. A
 * long tool step writes none, so the pipe also looks at the row: while no part has
 * arrived for {@link STOP_POLL_MS}. A stop found that way
 * is thrown as a refused write, the same as one found on a write, so the caller's
 * `endStoppedRun` saves the owed text and aborts the model call and its tools.
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import { stepCountIs } from "ai";
import type { ActionCtx } from "../../_generated/server";

/** Sentence delimiter check — same as persistent/client.ts:30. */
const hasDelimeter = (text: string) => text.includes(".") || text.includes("!") || text.includes("?");

/**
 * The longest buffered text waits for a delimiter before it is written anyway.
 * The gateway relay reads new chunks within ~50ms (`/chat/chunks` long-poll), so
 * this, not the relay, sets the update cadence of punctuation-free text.
 */
export const MAX_FLUSH_INTERVAL_MS = 150;

/** How long the pipe waits without a part before it asks whether the stream was stopped. */
export const STOP_POLL_MS = 2000;

/** The model stream yielded an `error` part. `cause` is the part's raw error. */
export class StreamFailedError extends Error {
    public constructor(cause: unknown) {
        // The caller's catch matches on `message` ("Rate limit", "not found") to
        // pick a safe user-facing text, so carry the provider's message through.
        let message = "Model stream failed";

        if (cause instanceof Error) {
            ({ message } = cause);
        } else if (typeof cause === "string") {
            message = cause;
        }

        super(message, { cause });
        this.name = "StreamFailedError";
    }
}

/** Brands a refused chunk write, so a caller can tell it from any other failure. */
const WRITE_REFUSED = Symbol.for("neore.stream-write-refused");

/** Text a run still owes its reply, as a refused write leaves it. */
export interface StreamText {
    reasoning: string;
    text: string;
}

/** A refused chunk write: the run's stream was ended while it was writing (a stop). */
export interface StreamWriteRefused extends Error {
    /** What the reply still needs: the text since the run's last finished step, and what was not yet written. */
    pending: StreamText;
}

/**
 * Wraps a `CONFLICT` from `addChunk`, which is how a stop shows up on a write. The original
 * error is the `cause`, so a refusal that is not a stop can be rethrown as it was.
 */
export const streamWriteRefused = (pending: StreamText, cause: unknown): StreamWriteRefused =>
    Object.assign(new Error("Stream write refused: the stream was ended", { cause }), { pending, [WRITE_REFUSED]: true });

export const isStreamWriteRefused = (error: unknown): error is StreamWriteRefused => typeof error === "object" && error !== null && WRITE_REFUSED in error;

/** The error a caller should see: the original of a refused write, anything else as it was. */
export const originalWriteError = (error: unknown): unknown => (isStreamWriteRefused(error) ? error.cause : error);

/** Turns a `CONFLICT` from `addChunk` into a refused write that keeps `pending`; any other error passes through. */
export const asRefusedWrite = (error: unknown, pending: StreamText): unknown => {
    // A thrown `LunoraError` carries `code`; a wire-decoded one carries it in `data`.
    const { code, data } = (error ?? {}) as { code?: unknown; data?: { code?: unknown } };

    return code === "CONFLICT" || data?.code === "CONFLICT" ? streamWriteRefused(pending, error) : error;
};

const STOPPED = Symbol("stopped");

/**
 * Whether a sidebar stop ended the stream row: `done` is only ever written to a run's live stream by
 * `stopActiveForThread`. A failed read is not a stop. Without `runQuery` there is nothing to ask.
 */
export const isStreamStopped = async (ctx: Partial<Pick<ActionCtx, "runQuery">>, streamId: string): Promise<boolean> =>
    ctx.runQuery !== undefined &&
    (await ctx
        .runQuery(internal.chat.streaming.persistent.library.getStreamStatus, { streamId: streamId as Id<"persistentStreams"> })
        .then((status) => status === "done")
        .catch(() => false));

/**
 * The `stopWhen` for a run's `streamText`: the step cap, and a stop found after a step's tools finished, so the
 * next model call never starts. The pipe cannot gate it, because the SDK starts the next step without waiting for a reader.
 */
export const stopWhenStopped = (ctx: Partial<Pick<ActionCtx, "runQuery">>, streamId: string, maxSteps: number) => [
    stepCountIs(maxSteps),
    async () => await isStreamStopped(ctx, streamId),
];

export interface PipedStream {
    /** Wall-clock ms of the first non-empty delta, if any. */
    firstTokenTime: number | undefined;
    /** Buffered text/reasoning not yet flushed — pass to the final chunk. */
    pending: StreamText;
    /** Text written since the last finished step. Those steps' messages are saved by the agent; this is the rest. */
    unsaved: StreamText;
}

/**
 * Yields `source`'s parts, and throws `onStop()` once `isStopped` answers true after `pollMs` without a part.
 * A part still pending then is abandoned: the abort the caller issues next ends it, and returning the
 * iterator now would wait on that pending read.
 */
async function* untilStopped<T>(source: AsyncIterable<T>, isStopped: () => Promise<boolean>, onStop: () => Error, pollMs: number): AsyncGenerator<T> {
    const iterator = source[Symbol.asyncIterator]();
    let lastPartAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let watching = true;
    let stopFound = false;
    // The wait for the part being read, if there is one. Each wait is its own promise, so nothing long-lived holds on to a settled part.
    let wake: (() => void) | undefined;
    const tick = () => {
        timer = setTimeout(async () => {
            if (watching && Date.now() - lastPartAt >= pollMs && (await isStopped())) {
                stopFound = true;
                wake?.();

                return;
            }

            if (watching) {
                tick();
            }
        }, pollMs);
    };

    tick();

    try {
        while (true) {
            const next = iterator.next();
            const step: IteratorResult<T> | typeof STOPPED = stopFound
                ? STOPPED
                : await new Promise<IteratorResult<T> | typeof STOPPED>((resolve, reject) => {
                      wake = () => {
                          resolve(STOPPED);
                      };
                      next.then(resolve).catch(reject);
                  });

            wake = undefined;

            if (step === STOPPED) {
                // The abandoned read may still fail once the caller aborts: nobody is left to hear it.
                next.catch(() => undefined);

                throw onStop();
            }

            if (step.done) {
                return;
            }

            lastPartAt = Date.now();

            yield step.value;
        }
    } finally {
        watching = false;
        clearTimeout(timer);
    }
}

export const pipeToPersistentChunks = async (
    // Without `runQuery` the pipe only learns of a stop from a refused write.
    ctx: Partial<Pick<ActionCtx, "runQuery">> & Pick<ActionCtx, "runMutation">,
    streamId: string,
    fullStream: AsyncIterable<{ error?: unknown; text?: string; type: string }>,
    { stopPollMs = STOP_POLL_MS }: { stopPollMs?: number } = {},
): Promise<PipedStream> => {
    let pending: StreamText = { reasoning: "", text: "" };
    let unsaved: StreamText = { reasoning: "", text: "" };
    let firstTokenTime: number | undefined;
    let streamError: { error: unknown } | undefined;
    /** When the last chunk was written; `undefined` until the first one is. */
    let lastFlushAt: number | undefined;

    const flush = async (): Promise<void> => {
        const chunk = pending;
        const owed = { reasoning: unsaved.reasoning + chunk.reasoning, text: unsaved.text + chunk.text };

        try {
            await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
                final: false,
                reasoning: chunk.reasoning || undefined,
                streamId: streamId as Id<"persistentStreams">,
                text: chunk.text,
            });
        } catch (error) {
            throw asRefusedWrite(error, owed);
        }

        unsaved = owed;
        pending = { reasoning: "", text: "" };
        lastFlushAt = Date.now();
    };

    const isStopped = async () => await isStreamStopped(ctx, streamId);
    const refusedByStop = () =>
        streamWriteRefused({ reasoning: unsaved.reasoning + pending.reasoning, text: unsaved.text + pending.text }, new Error("Stream was stopped"));

    // `fullStream`, not `textStream`: reasoning deltas only exist on the full
    // stream, and the client renders them live from `persistentChunks.reasoning`.
    const parts = ctx.runQuery === undefined ? fullStream : untilStopped(fullStream, isStopped, refusedByStop, stopPollMs);

    for await (const part of parts) {
        let delta: string;

        switch (part.type) {
            case "reasoning-delta": {
                delta = part.text ?? "";
                pending.reasoning += delta;
                break;
            }
            case "text-delta": {
                delta = part.text ?? "";
                pending.text += delta;
                break;
            }
            case "error": {
                // Keep draining: the SDK closes the stream after an error, and an
                // abandoned reader would leave the underlying response body open.
                streamError ??= { error: part.error };
                continue;
            }
            default: {
                // Flush at the reasoning → answer boundary so the client can collapse
                // the reasoning panel as soon as it ends, not a sentence later.
                if (part.type === "reasoning-end" && pending.reasoning) {
                    await flush();
                }

                // A finished step is saved as its own message by the agent, so from here on its text is not the reply's to keep.
                if (part.type === "finish-step") {
                    if (pending.text || pending.reasoning) {
                        try {
                            await flush();
                        } catch (error) {
                            // The agent saves this step itself, so a refusal here owes nothing.
                            throw isStreamWriteRefused(error) ? streamWriteRefused({ reasoning: "", text: "" }, error.cause) : error;
                        }
                    }

                    unsaved = { reasoning: "", text: "" };
                }

                continue;
            }
        }

        if (delta.length === 0) {
            continue;
        }

        firstTokenTime ??= Date.now();

        if (lastFlushAt === undefined || hasDelimeter(delta) || Date.now() - lastFlushAt >= MAX_FLUSH_INTERVAL_MS) {
            await flush();
        }
    }

    if (streamError) {
        // Keep the partial answer visible above the error line the caller appends.
        if (pending.text || pending.reasoning) {
            await flush();
        }

        throw new StreamFailedError(streamError.error);
    }

    return { firstTokenTime, pending, unsaved };
};
