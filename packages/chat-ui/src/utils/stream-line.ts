/**
 * The gateway's `/v1/stream` NDJSON relay protocol (edge streaming, see
 * CLAUDE.md), shared by the web app and the browser extension so neither can
 * drift from the other.
 */

/** Group chat: the participant whose reply starts with this chunk; its text and reasoning are theirs. */
export interface StreamSpeaker {
    name: string;
    skillId: string;
}

/**
 * One NDJSON line relayed by the gateway's `/v1/stream`: a `persistentChunks` row
 * (`{ text, reasoning?, speaker? }`), an error object, or — for a request sent
 * with `resumable: true` — the resume marker
 * `{ type: "resume", lastChunkIndex }`, always the last line of a relay that
 * ran out of its per-request budget. It is not a chunk: the reader asks again
 * with that `lastChunkIndex` and counts nothing for it.
 */
export type ParsedStreamLine =
    | { error: unknown; kind: "error" }
    | { kind: "chunk"; reasoning: string; speaker?: StreamSpeaker; text: string }
    | { kind: "resume"; lastChunkIndex: number };

const readSpeaker = (value: unknown): StreamSpeaker | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { name, skillId } = value as { name?: unknown; skillId?: unknown };

    return typeof name === "string" && typeof skillId === "string" ? { name, skillId } : undefined;
};

/**
 * Parse one relayed line. A line that is not JSON is treated as plain answer text,
 * which is what the stream reader did before reasoning was relayed.
 */
export const parseStreamLine = (line: string): ParsedStreamLine => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(line);
    } catch {
        return { kind: "chunk", reasoning: "", text: line };
    }

    if (typeof parsed !== "object" || parsed === null) {
        return { kind: "chunk", reasoning: "", text: line };
    }

    const {
        error,
        lastChunkIndex,
        reasoning,
        speaker: rawSpeaker,
        text,
        type,
    } = parsed as { error?: unknown; lastChunkIndex?: unknown; reasoning?: unknown; speaker?: unknown; text?: unknown; type?: unknown };

    if (error) {
        return { error, kind: "error" };
    }

    if (type === "resume" && typeof lastChunkIndex === "number" && Number.isSafeInteger(lastChunkIndex) && lastChunkIndex >= 0) {
        return { kind: "resume", lastChunkIndex };
    }

    const speaker = readSpeaker(rawSpeaker);

    return {
        kind: "chunk",
        reasoning: typeof reasoning === "string" ? reasoning : "",
        ...(speaker && { speaker }),
        text: typeof text === "string" ? text : "",
    };
};
