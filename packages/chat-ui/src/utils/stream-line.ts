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
 * A running MCP tool call's latest progress report, or its end (`ended`). `total` is absent when the
 * server does not know it (an indeterminate task). Untrusted values are clamped by {@link readToolProgress}.
 */
export interface ToolProgressEvent {
    ended?: true;
    message?: string;
    progress?: number;
    serverName: string;
    toolCallId: string;
    toolName: string;
    total?: number;
}

/**
 * One NDJSON line relayed by the gateway's `/v1/stream`: a `persistentChunks` row
 * (`{ text, reasoning?, speaker?, restart? }`), an error object, or — for a request sent
 * with `resumable: true` — the resume marker
 * `{ type: "resume", lastChunkIndex }`, always the last line of a relay that
 * ran out of its per-request budget. It is not a chunk: the reader asks again
 * with that `lastChunkIndex` and counts nothing for it. A reply that finished, for
 * a request that sent `endMarker: true`, ends with `{ type: "end" }`, so the reader
 * can tell it from a cut stream.
 */
export type ParsedStreamLine =
    | { kind: "end" }
    | { error: unknown; kind: "error" }
    /** `restart`: the reply continues below a message the user steered into it; what came before is saved. */
    | { kind: "chunk"; reasoning: string; restart?: true; speaker?: StreamSpeaker; text: string; toolProgress?: ToolProgressEvent }
    | { kind: "resume"; lastChunkIndex: number };

const readSpeaker = (value: unknown): StreamSpeaker | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { name, skillId } = value as { name?: unknown; skillId?: unknown };

    return typeof name === "string" && typeof skillId === "string" ? { name, skillId } : undefined;
};

const MAX_MESSAGE_LENGTH = 200;

/** A `toolProgress` field off the wire, or `undefined` when it is not one. The numbers and text are the server's: clamped here. */
export const readToolProgress = (value: unknown): ToolProgressEvent | undefined => {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }

    const { ended, message, progress, serverName, toolCallId, toolName, total } = value as {
        ended?: unknown;
        message?: unknown;
        progress?: unknown;
        serverName?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        total?: unknown;
    };

    if (typeof toolCallId !== "string" || toolCallId === "" || typeof serverName !== "string" || typeof toolName !== "string") {
        return undefined;
    }

    const event = { serverName, toolCallId, toolName };

    if (ended === true) {
        return { ...event, ended: true };
    }

    if (typeof progress !== "number" || !Number.isFinite(progress) || progress < 0) {
        return undefined;
    }

    const text = typeof message === "string" ? message.trim().slice(0, MAX_MESSAGE_LENGTH) : "";

    return {
        ...event,
        ...(text && { message: text }),
        progress,
        ...(typeof total === "number" && Number.isFinite(total) && total > 0 && { total }),
    };
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
        restart,
        speaker: rawSpeaker,
        text,
        toolProgress: rawToolProgress,
        type,
    } = parsed as {
        error?: unknown;
        lastChunkIndex?: unknown;
        reasoning?: unknown;
        restart?: unknown;
        speaker?: unknown;
        text?: unknown;
        toolProgress?: unknown;
        type?: unknown;
    };

    if (error) {
        return { error, kind: "error" };
    }

    if (type === "resume" && typeof lastChunkIndex === "number" && Number.isSafeInteger(lastChunkIndex) && lastChunkIndex >= 0) {
        return { kind: "resume", lastChunkIndex };
    }

    if (type === "end") {
        return { kind: "end" };
    }

    const speaker = readSpeaker(rawSpeaker);
    const toolProgress = readToolProgress(rawToolProgress);

    return {
        kind: "chunk",
        reasoning: typeof reasoning === "string" ? reasoning : "",
        ...(restart === true && { restart: true as const }),
        ...(speaker && { speaker }),
        text: typeof text === "string" ? text : "",
        ...(toolProgress && { toolProgress }),
    };
};
