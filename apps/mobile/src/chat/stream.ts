/**
 * Reads the gateway's `/v1/stream` NDJSON relay. Pure: `fetch` is injected, so the
 * framing and the resume loop are tested under vitest. The line grammar itself
 * (chunk, error, resume marker) is `parseStreamLine` from the `@neore/chat-ui`
 * package, shared with the web app and the extension.
 */
import { parseStreamLine } from "@neore/chat-ui/utils/stream-line";

import type { Fetch } from "../auth/grant";

export interface StreamDelta {
    reasoning: string;
    text: string;
}

export type StreamOutcome = "failed" | "finished";

/** Resumes after a relay ran out of its per-request budget. Bounds a stuck loop. */
export const MAX_RESUMES = 50;

/**
 * Split a buffer into complete lines and the unfinished tail. A line can arrive
 * split across two reads, or several lines in one read.
 */
export const splitLines = (buffer: string): { lines: string[]; rest: string } => {
    const parts = buffer.split("\n");
    const rest = parts.pop() ?? "";

    return { lines: parts.filter((line) => line.trim() !== ""), rest };
};

/* eslint-disable no-await-in-loop -- a stream is read in order: each read and each line depends on the one before */

/** A relay that sends nothing for this long is treated as dead: the reply fails rather than waiting forever. */
const IDLE_TIMEOUT_MS = 60_000;

const readWithIdleTimeout = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        return await Promise.race([
            reader.read(),
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(reject, IDLE_TIMEOUT_MS, new Error("the reply went silent"));
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};

/** The next read, or `undefined` when the relay went silent or the stream errored: the reply has failed by then. */
const readOrNull = async (reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array> | undefined> => {
    try {
        return await readWithIdleTimeout(reader);
    } catch {
        try {
            await reader.cancel();
        } catch {
            // The stream already errored: nothing is left to cancel.
        }

        return undefined;
    }
};

/** One POST's worth of lines. Returns what ended it. */
const readAttempt = async (
    stream: ReadableStream<Uint8Array>,
    onChunk: (delta: StreamDelta, index: number) => void,
    startIndex: number,
): Promise<"done" | "failed" | "resume"> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let index = startIndex;
    let isResumed = false;
    let isEnded = false;

    /** Returns false when the line is an error, which fails the whole reply. */
    const isLineOk = (line: string): boolean => {
        const parsed = parseStreamLine(line);

        if (parsed.kind === "error") {
            return false;
        }

        if (parsed.kind === "end") {
            isEnded = true;

            return true;
        }

        if (parsed.kind === "resume") {
            // The marker is the last line; the chunks counted so far are its index.
            isResumed = true;
            index = parsed.lastChunkIndex;

            return true;
        }

        index += 1;
        onChunk({ reasoning: parsed.reasoning, text: parsed.text }, index);

        return true;
    };

    while (true) {
        const read = await readOrNull(reader);

        if (read === undefined) {
            return "failed";
        }

        const { done, value } = read;

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = splitLines(buffer);

        buffer = rest;

        for (const line of lines) {
            if (!isLineOk(line)) {
                await reader.cancel();

                return "failed";
            }
        }
    }

    buffer += decoder.decode();

    if (buffer.trim() !== "" && !isLineOk(buffer.trim())) {
        return "failed";
    }

    if (isResumed) {
        return "resume";
    }

    // Closing without the end line means the connection dropped mid-reply: not a finished one.
    return isEnded ? "done" : "failed";
};
/* eslint-enable no-await-in-loop */

/* eslint-disable no-await-in-loop -- each POST resumes from the index the previous one counted */

/**
 * Relay one reply. `onDelta` is called once per relayed chunk. A resume marker
 * makes the loop POST again with the counted `lastChunkIndex`, so nothing is sent
 * twice or skipped. Resolves "finished" for 205 or a relay that ends with the end
 * line, "failed" for a bad status, a missing body, an error line, or a stream that
 * closes with neither the end line nor a resume marker (cut off).
 */
export const relayReply = async (input: {
    fetch: Fetch;
    gatewayUrl: string;
    onDelta: (delta: StreamDelta) => void;
    signal?: AbortSignal;
    streamToken: string;
}): Promise<StreamOutcome> => {
    let counted = 0;

    for (let attempt = 0; attempt <= MAX_RESUMES; attempt += 1) {
        const resumeFrom = counted > 0 ? { lastChunkIndex: counted } : {};
        const body = { endMarker: true, resumable: true, streamToken: input.streamToken, ...resumeFrom };

        const response = await input.fetch(`${input.gatewayUrl}/v1/stream`, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal: input.signal,
        });

        if (response.status === 205) {
            await response.body?.cancel();

            return "finished";
        }

        if (!response.ok || !response.body) {
            await response.body?.cancel();

            return "failed";
        }

        const outcome = await readAttempt(
            response.body,
            (delta, index) => {
                counted = index;
                input.onDelta(delta);
            },
            counted,
        );

        if (outcome === "failed") {
            return "failed";
        }

        if (outcome === "done") {
            return "finished";
        }

        // "resume": the relay stopped at its budget; loop with `counted`.
    }

    return "failed";
};
/* eslint-enable no-await-in-loop */
