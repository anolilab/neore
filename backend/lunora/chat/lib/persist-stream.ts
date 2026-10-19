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
 */
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ActionCtx } from "../../_generated/server";

/** Sentence delimiter check — same as persistent/client.ts:30. */
const hasDelimeter = (text: string) => text.includes(".") || text.includes("!") || text.includes("?");

/**
 * The longest buffered text waits for a delimiter before it is written anyway.
 * The gateway relay reads new chunks within ~50ms (`/chat/chunks` long-poll), so
 * this, not the relay, sets the update cadence of punctuation-free text.
 */
export const MAX_FLUSH_INTERVAL_MS = 150;

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

/** For a caller that does not handle a stop: rethrows the original error, so its behaviour is unchanged. */
export const rethrowOriginalWriteError = (error: unknown): never => {
    throw originalWriteError(error);
};

/** Turns a `CONFLICT` from `addChunk` into a refused write that keeps `pending`; any other error passes through. */
export const asRefusedWrite = (error: unknown, pending: StreamText): unknown => {
    // A thrown `LunoraError` carries `code`; a wire-decoded one carries it in `data`.
    const { code, data } = (error ?? {}) as { code?: unknown; data?: { code?: unknown } };

    return code === "CONFLICT" || data?.code === "CONFLICT" ? streamWriteRefused(pending, error) : error;
};

export interface PipedStream {
    /** Wall-clock ms of the first non-empty delta, if any. */
    firstTokenTime: number | undefined;
    /** Buffered text/reasoning not yet flushed — pass to the final chunk. */
    pending: StreamText;
    /** Text written since the last finished step. Those steps' messages are saved by the agent; this is the rest. */
    unsaved: StreamText;
}

export const pipeToPersistentChunks = async (
    ctx: Pick<ActionCtx, "runMutation">,
    streamId: string,
    fullStream: AsyncIterable<{ error?: unknown; text?: string; type: string }>,
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

    // `fullStream`, not `textStream`: reasoning deltas only exist on the full
    // stream, and the client renders them live from `persistentChunks.reasoning`.
    for await (const part of fullStream) {
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
                        await flush();
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
