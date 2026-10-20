/**
 * Reads the gateway's `/v1/stream` NDJSON relay. Pure: `fetch` is injected, so the
 * framing and the resume loop are tested under vitest. The line grammar itself
 * (chunk, error, resume marker) is `parseStreamLine` from @neore/chat-ui, shared
 * with the web app and the extension.
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
        const body = { endMarker: true, resumable: true, streamToken: input.streamToken, ...(counted > 0 && { lastChunkIndex: counted }) };

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
    const handle = (line: string): boolean => {
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
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        buffer += decoder.decode(value, { stream: true });
        const { lines, rest } = splitLines(buffer);

        buffer = rest;

        for (const line of lines) {
            if (!handle(line)) {
                await reader.cancel();

                return "failed";
            }
        }
    }

    buffer += decoder.decode();

    if (buffer.trim() !== "" && !handle(buffer.trim())) {
        return "failed";
    }

    if (isResumed) {
        return "resume";
    }

    // Closing without the end line means the connection dropped mid-reply: not a finished one.
    return isEnded ? "done" : "failed";
};
