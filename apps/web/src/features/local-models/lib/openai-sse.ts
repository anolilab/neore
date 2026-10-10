/**
 * Streaming parser for OpenAI-compatible `/v1/chat/completions` SSE, as Ollama
 * and LM Studio emit it.
 *
 * Kept separate from the fetch so it can be fed arbitrary chunk boundaries in
 * tests: the network splits wherever it likes — mid-line, mid-`\r\n`, mid
 * UTF-8 sequence (the caller's `TextDecoder` with `stream: true` handles that
 * last one).
 */

export interface ChatCompletionDelta {
    content: string;
    finishReason?: string;
    /** Thinking text: Ollama sends `delta.reasoning`, LM Studio `delta.reasoning_content`. */
    reasoning: string;
    usage?: { completionTokens?: number; promptTokens?: number };
}

export type SseEvent = { data: string; type: "data" } | { type: "done" };

const LINE_BREAK_RE = /\r\n|\r|\n/;

/**
 * Incremental SSE line reader. `feed` returns the events completed by this
 * chunk; `flush` returns whatever a final unterminated line held.
 *
 * Only `data:` fields matter here — comments (`:`), `event:`, `id:` and
 * `retry:` are ignored. Multi-line `data:` fields of one event are joined with
 * `\n` per the SSE spec; a blank line dispatches.
 */
export const createSseParser = () => {
    let buffer = "";
    let dataLines: string[] = [];

    const dispatch = (out: SseEvent[]) => {
        if (dataLines.length === 0) {
            return;
        }

        const data = dataLines.join("\n");

        dataLines = [];
        out.push(data.trim() === "[DONE]" ? { type: "done" } : { data, type: "data" });
    };

    const consumeLine = (line: string, out: SseEvent[]) => {
        if (line === "") {
            dispatch(out);

            return;
        }

        if (line.startsWith("data:")) {
            // One optional space after the colon belongs to the syntax, not the value.
            dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
        }
    };

    return {
        flush: (): SseEvent[] => {
            const out: SseEvent[] = [];

            if (buffer) {
                consumeLine(buffer, out);
                buffer = "";
            }

            dispatch(out);

            return out;
        },
        feed: (chunk: string): SseEvent[] => {
            const out: SseEvent[] = [];

            buffer += chunk;

            // A trailing `\r` may be the first half of `\r\n`; wait for the next chunk.
            let match = LINE_BREAK_RE.exec(buffer);

            while (match && !(match[0] === "\r" && match.index === buffer.length - 1)) {
                consumeLine(buffer.slice(0, match.index), out);
                buffer = buffer.slice(match.index + match[0].length);
                match = LINE_BREAK_RE.exec(buffer);
            }

            return out;
        },
    };
};

/** An error object some servers send mid-stream instead of a chunk. */
export class LocalStreamError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "LocalStreamError";
    }
}

/**
 * Read one `chat.completion.chunk`. Unknown shapes yield an empty delta
 * rather than throwing — a server adding fields must not break the stream —
 * but an `{ error }` payload throws, since the text that follows is nothing.
 */
export const parseChatCompletionChunk = (data: string): ChatCompletionDelta => {
    let json: unknown;

    try {
        json = JSON.parse(data);
    } catch {
        return { content: "", reasoning: "" };
    }

    if (!json || typeof json !== "object") {
        return { content: "", reasoning: "" };
    }

    const record = json as {
        choices?: { delta?: Record<string, unknown>; finish_reason?: unknown }[];
        error?: unknown;
        usage?: { completion_tokens?: unknown; prompt_tokens?: unknown };
    };

    if (record.error) {
        const message = typeof record.error === "string" ? record.error : (record.error as { message?: unknown }).message;

        throw new LocalStreamError(typeof message === "string" && message ? message : "The local model reported an error");
    }

    const choice = record.choices?.[0];
    const delta = choice?.delta ?? {};
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const result: ChatCompletionDelta = {
        content: text(delta.content),
        reasoning: text(delta.reasoning) || text(delta.reasoning_content),
    };

    if (typeof choice?.finish_reason === "string") {
        result.finishReason = choice.finish_reason;
    }

    if (record.usage) {
        result.usage = {
            ...(typeof record.usage.completion_tokens === "number" && { completionTokens: record.usage.completion_tokens }),
            ...(typeof record.usage.prompt_tokens === "number" && { promptTokens: record.usage.prompt_tokens }),
        };
    }

    return result;
};
