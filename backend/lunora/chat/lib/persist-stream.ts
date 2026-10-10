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

export interface PipedStream {
    /** Wall-clock ms of the first non-empty delta, if any. */
    firstTokenTime: number | undefined;
    /** Buffered text/reasoning not yet flushed — pass to the final chunk. */
    pending: { reasoning: string; text: string };
}

export const pipeToPersistentChunks = async (
    ctx: Pick<ActionCtx, "runMutation">,
    streamId: string,
    fullStream: AsyncIterable<{ error?: unknown; text?: string; type: string }>,
): Promise<PipedStream> => {
    let pending = { reasoning: "", text: "" };
    let firstTokenTime: number | undefined;
    let streamError: { error: unknown } | undefined;
    /** When the last chunk was written; `undefined` until the first one is. */
    let lastFlushAt: number | undefined;

    const flush = async (): Promise<void> => {
        await ctx.runMutation(internal.chat.streaming.persistent.library.addChunk, {
            final: false,
            reasoning: pending.reasoning || undefined,
            streamId: streamId as Id<"persistentStreams">,
            text: pending.text,
        });
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

    return { firstTokenTime, pending };
};
