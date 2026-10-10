import type { StreamSpeaker } from "@neore/chat-ui/utils/stream-line";
import { parseStreamLine } from "@neore/chat-ui/utils/stream-line";

/**
 * Client for the gateway's `/v1/stream` NDJSON relay (edge streaming, see
 * CLAUDE.md). Lines are parsed by `@neore/chat-ui/utils/stream-line`, the same
 * parser the web app uses.
 */

/**
 * Splits a byte stream into complete lines. `push` returns the lines finished
 * by this chunk and keeps the unterminated tail for the next one.
 */
export const createLineBuffer = () => {
    let buffer = "";

    return {
        flush: (): string[] => {
            const rest = buffer.trim();

            buffer = "";

            return rest ? [rest] : [];
        },
        push: (chunk: string): string[] => {
            buffer += chunk;

            const lines = buffer.split("\n");

            buffer = lines.pop() ?? "";

            return lines.filter((line) => line.trim());
        },
    };
};

export interface StreamDelta {
    reasoning: string;
    /** Group chat: a new participant's reply starts with this delta. */
    speaker?: StreamSpeaker;
    text: string;
}

type AttemptResult = "done" | "disconnected" | "failed" | "finished" | "resume";

const MAX_RECONNECTS = 3;
const RECONNECT_BASE_DELAY_MS = 1000;

/**
 * Stream one reply, reconnecting after a dropped connection from the last
 * chunk received (`lastChunkIndex`). The request opts in to resume markers: the
 * gateway ends a long relay with `{ type: "resume", lastChunkIndex }` before it
 * runs out of subrequests, and the reply continues in a new request at once —
 * not counted as a reconnect, and with no delay. Resolves when the relay ends; rejects on a
 * relayed error. The persisted message in Lunora remains the source of truth
 * either way — this only makes the text appear as it is written.
 */
export const streamReply = async (gatewayOrigin: string, streamToken: string, onDelta: (delta: StreamDelta) => void, signal: AbortSignal): Promise<void> => {
    let chunkCount = 0;

    const attempt = async (): Promise<AttemptResult> => {
        const response = await fetch(new URL("/v1/stream", gatewayOrigin), {
            body: JSON.stringify({ resumable: true, streamToken, ...(chunkCount > 0 && { lastChunkIndex: chunkCount }) }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
            signal,
        });

        // 205: the stream already finished; the persisted message has it all.
        if (response.status === 205) {
            await response.body?.cancel();

            return "finished";
        }

        if (!response.ok || !response.body) {
            await response.body?.cancel();

            return "failed";
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const lines = createLineBuffer();

        let isResumed = false;

        const handle = (line: string) => {
            const parsed = parseStreamLine(line);

            if (parsed.kind === "error") {
                throw new Error(typeof parsed.error === "string" ? parsed.error : "The model stopped with an error.");
            }

            // The relay's last line: where the next request continues. Not a chunk.
            if (parsed.kind === "resume") {
                chunkCount = parsed.lastChunkIndex;
                isResumed = true;

                return;
            }

            chunkCount += 1;
            onDelta({ reasoning: parsed.reasoning, speaker: parsed.speaker, text: parsed.text });
        };

        while (true) {
            let result: ReadableStreamReadResult<Uint8Array>;

            try {
                result = await reader.read();
            } catch {
                return signal.aborted ? "finished" : "disconnected";
            }

            if (result.done) {
                for (const line of lines.flush()) {
                    handle(line);
                }

                return isResumed ? "resume" : "done";
            }

            // eslint-disable-next-line unicorn/no-return-array-push -- the line buffer's `push`, which returns the lines it completed
            const complete = lines.push(decoder.decode(result.value, { stream: true }));

            for (const line of complete) {
                handle(line);
            }
        }
    };

    for (let reconnects = 0; reconnects <= MAX_RECONNECTS;) {
        if (signal.aborted) {
            return;
        }

        let result: AttemptResult;

        try {
            result = await attempt();
        } catch (error) {
            if (signal.aborted) {
                return;
            }

            // A relayed `{ error }` is final; a network failure is worth retrying.
            if (error instanceof Error && !(error instanceof TypeError)) {
                throw error;
            }

            result = "disconnected";
        }

        // A planned hand-over, not a failure: continue at once.
        if (result === "resume") {
            continue;
        }

        if (result !== "disconnected") {
            return;
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, RECONNECT_BASE_DELAY_MS * 2 ** reconnects);
        });
        reconnects += 1;
    }
};
