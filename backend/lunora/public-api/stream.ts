/**
 * Relays a persistent stream (`persistentChunks`) to an API caller.
 *
 * The same chunks the gateway's `/v1/stream` relays to the browser, polled the
 * same way (fast while chunks arrive, slower when idle, terminal on
 * done/error/timeout). Serving it from the backend keeps an API client on ONE
 * base URL; the returned `streamToken` also works against the gateway.
 *
 * Wire format — NDJSON, one event per line:
 *
 *   {"type":"text","text":"Hel"}
 *   {"type":"reasoning","text":"…"}
 *   {"type":"speaker","name":"Researcher","skillId":"…"}
 *   {"type":"done","status":"done"}
 *   {"type":"error","error":{"code":"…","message":"…"}}
 *   {"type":"resume","lastChunkIndex":40}      (only with `resumable: true`)
 *
 * `done` or `error` is always the last line — or, for a caller that sent
 * `resumable: true`, `resume`: the relay used up its read budget and the caller
 * continues with `lastChunkIndex` in a new request. A stream that ends without
 * one of these was cut by the network; the finished reply is in the thread's
 * messages.
 *
 * ## Why a read budget
 *
 * Every read is a `runQuery` from this Worker to the stream's shard Durable
 * Object — a subrequest, and Workers cap those per invocation (50 on the Free
 * plan), counting the router's own auth and rate-limit calls. So one invocation
 * reads at most {@link STREAM_MAX_READS} times: a streaming relay then hands
 * over (`resume`) or, for a caller that did not opt in, ends with a
 * `relay_budget` error pointing at the thread's messages; a blocking read
 * stretches its polls ({@link blockingPollDelay}) to fit its five minutes.
 */

export type StreamEvent =
    | { error: { code: string; message: string }; type: "error" }
    | { lastChunkIndex: number; type: "resume" }
    | { name: string; skillId: string; type: "speaker" }
    | { status: string; type: "done" }
    | { text: string; type: "reasoning" }
    | { text: string; type: "text" };

export interface StreamChunk {
    reasoning?: string;
    speaker?: { name: string; skillId: string };
    text: string;
}

/** One read of the stream: the chunks past `afterIndex` and the status, from ONE query, so they agree. */
export interface StreamSource {
    read: (afterIndex: number) => Promise<{ chunks: StreamChunk[]; status: string }>;
}

export const TERMINAL_STREAM_STATUSES: ReadonlySet<string> = new Set(["done", "error", "timeout"]);

const POLL_FAST_MS = 150;
const POLL_SLOW_MS = 600;
const BACKOFF_AFTER_EMPTY_POLLS = 5;

/**
 * Stream reads per invocation. The router spends a few subrequests of its own
 * before the handler runs (API key, rate limit, shard lookup) and `/chat` with
 * `stream: false` spends about fifteen starting the chat, so this leaves room
 * under the Free plan's 50 either way.
 */
export const STREAM_MAX_READS = 30;

/**
 * Poll interval for a blocking read: grows from ~300ms by a quarter per read,
 * capped at 22s, so {@link STREAM_MAX_READS} reads span the five minutes a
 * blocking chat may wait — a short reply is still noticed within a quarter of
 * its own length.
 */
export const blockingPollDelay = (reads: number): number => Math.min(22_000, Math.round(250 * 1.25 ** reads));

/** Longer than the 20-minute stream TTL, so a live stream is never cut by the relay first. */
export const MAX_RELAY_DURATION_MS = 21 * 60 * 1000;

export interface PollOptions {
    afterIndex?: number;
    /** The wait before the next read, given the reads so far and the empty ones in a row. Default: 150ms, 600ms once idle. */
    delay?: (reads: number, emptyPolls: number) => number;
    maxDurationMs?: number;
    /** Reads this invocation may make. Default {@link STREAM_MAX_READS}. */
    maxReads?: number;
    now?: () => number;
    /** The caller follows `resume` events; without it, running out of reads ends in a `relay_budget` error. */
    resumable?: boolean;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
}

const streamingPollDelay = (_reads: number, emptyPolls: number): number => (emptyPolls >= BACKOFF_AFTER_EMPTY_POLLS ? POLL_SLOW_MS : POLL_FAST_MS);

const defaultSleep = async (ms: number): Promise<void> => {
    await new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

export const chunkToEvents = (chunk: StreamChunk): StreamEvent[] => {
    const events: StreamEvent[] = [];

    if (chunk.speaker) {
        events.push({ name: chunk.speaker.name, skillId: chunk.speaker.skillId, type: "speaker" });
    }

    if (chunk.reasoning) {
        events.push({ text: chunk.reasoning, type: "reasoning" });
    }

    if (chunk.text) {
        events.push({ text: chunk.text, type: "text" });
    }

    return events;
};

/**
 * Poll until the stream is terminal, yielding events as chunks land — or until
 * the read budget is spent (see the module comment).
 *
 * Chunks and status come from one read, so a terminal status is never seen
 * without the chunks written before it.
 */
export async function* pollStream(source: StreamSource, options: PollOptions = {}): AsyncGenerator<StreamEvent> {
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const delay = options.delay ?? streamingPollDelay;
    const maxReads = options.maxReads ?? STREAM_MAX_READS;
    const deadline = now() + (options.maxDurationMs ?? MAX_RELAY_DURATION_MS);
    let afterIndex = options.afterIndex ?? 0;
    let emptyPolls = 0;
    let reads = 0;

    while (!options.signal?.aborted) {
        const { chunks, status } = await source.read(afterIndex);

        reads += 1;
        afterIndex += chunks.length;

        for (const chunk of chunks) {
            yield* chunkToEvents(chunk);
        }

        if (TERMINAL_STREAM_STATUSES.has(status)) {
            yield status === "error" || status === "timeout"
                ? {
                      error: { code: status === "timeout" ? "stream_timeout" : "generation_failed", message: `The generation ended with status "${status}".` },
                      type: "error",
                  }
                : { status, type: "done" };

            return;
        }

        if (now() >= deadline) {
            yield { error: { code: "relay_timeout", message: "The stream did not finish in time. Read the reply from the thread's messages." }, type: "error" };

            return;
        }

        if (reads >= maxReads) {
            yield options.resumable
                ? { lastChunkIndex: afterIndex, type: "resume" }
                : {
                      error: {
                          code: "relay_budget",
                          message:
                              "The stream relay reached its per-request limit. Send `resumable: true` to continue it, or read the reply from the thread's messages.",
                      },
                      type: "error",
                  };

            return;
        }

        emptyPolls = chunks.length > 0 ? 0 : emptyPolls + 1;
        await sleep(delay(reads, emptyPolls));
    }
}

export interface CollectedStream {
    reasoning: string;
    status: string;
    text: string;
}

/**
 * Drain a stream into one blocking completion. Its polls stretch
 * ({@link blockingPollDelay}) so the read budget spans the whole wait; running
 * out of it reads as `relay_budget`.
 */
export const collectStream = async (source: StreamSource, options: PollOptions = {}): Promise<CollectedStream> => {
    let text = "";
    let reasoning = "";
    let status = "unknown";

    const events = pollStream(source, { delay: blockingPollDelay, ...options });

    for await (const event of events) {
        switch (event.type) {
            case "done": {
                status = event.status;
                break;
            }
            case "error": {
                status = event.error.code;
                break;
            }
            case "reasoning": {
                reasoning += event.text;
                break;
            }
            case "resume": {
                break;
            }
            case "speaker": {
                break;
            }
            case "text": {
                text += event.text;
                break;
            }
            default: {
                break;
            }
        }
    }

    return { reasoning, status, text };
};

/** Encode the poller as an NDJSON body. */
export const toNdjsonStream = (events: AsyncGenerator<StreamEvent>): ReadableStream<Uint8Array> => {
    const encoder = new TextEncoder();

    return new ReadableStream<Uint8Array>({
        async cancel() {
            await events.return(undefined);
        },
        async pull(controller) {
            try {
                const { done, value } = await events.next();

                if (done) {
                    controller.close();

                    return;
                }

                controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
            } catch {
                controller.enqueue(
                    encoder.encode(`${JSON.stringify({ error: { code: "relay_error", message: "The stream relay failed." }, type: "error" })}\n`),
                );
                controller.close();
            }
        },
    });
};
