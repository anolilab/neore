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
 *   {"type":"reply.restart"}                   (the reply was steered; see below)
 *   {"type":"done","status":"done"}
 *   {"type":"done","status":"waiting_on_person","pendingRequest":{…}}   (the run paused for a person)
 *   {"type":"error","error":{"code":"…","message":"…"}}
 *   {"type":"resume","lastChunkIndex":40}      (only with `resumable: true`)
 *
 * `reply.restart` marks the cut when the user steered the reply from the app: everything before it
 * is the text of the reply as it stood, everything after continues below the steering message. A
 * client that wants one text just keeps appending ({@link collectStream} does).
 *
 * A run that pauses on a tool approval or an `askUser` question ends `done` like any other, so the relay
 * reports it as `status: "waiting_on_person"` with the `pendingRequest` (read-only here: a person answers in
 * the app, and the reply is then in the thread's messages).
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
import { sleep } from "../chat/tools/utilities";
import { httpLogger } from "../lib/logger";

/** A request the run paused on, which only a person can answer in the app. */
export interface PendingRequest {
    /** An `askUser` call's question text. */
    question?: string;
    toolCallId: string;
    toolName: string | null;
}

export const WAITING_ON_PERSON = "waiting_on_person";

/** A blocking read that lost the stream part-way: the rest of the reply is in the thread's messages. */
export const INTERRUPTED = "interrupted";

export type StreamEvent =
    | { error: { code: string; message: string }; type: "error" }
    | { lastChunkIndex: number; type: "resume" }
    | { name: string; skillId: string; type: "speaker" }
    | { type: "reply.restart" }
    | { pendingRequest?: PendingRequest; status: string; type: "done" }
    | { text: string; type: "reasoning" }
    | { text: string; type: "text" };

export interface StreamChunk {
    reasoning?: string;
    /** The reply continues below a message the user steered into it. */
    restart?: boolean;
    speaker?: { name: string; skillId: string };
    text: string;
}

/** One read of the stream: the chunks past `afterIndex` and the status, from ONE query, so they agree. */
export interface StreamSource {
    /** `locked`: the thread was locked after the stream started, so nothing more may be relayed. */
    read: (afterIndex: number) => Promise<{ chunks: StreamChunk[]; locked?: boolean; pendingRequest?: PendingRequest; status: string }>;
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

export const chunkToEvents = (chunk: StreamChunk): StreamEvent[] => {
    const events: StreamEvent[] = [];

    if (chunk.speaker) {
        events.push({ name: chunk.speaker.name, skillId: chunk.speaker.skillId, type: "speaker" });
    }

    // Before the chunk's own text: what it carries belongs after the cut.
    if (chunk.restart) {
        events.push({ type: "reply.restart" });
    }

    if (chunk.reasoning) {
        events.push({ text: chunk.reasoning, type: "reasoning" });
    }

    if (chunk.text) {
        events.push({ text: chunk.text, type: "text" });
    }

    return events;
};

const terminalEvent = (status: string, pendingRequest: PendingRequest | undefined): StreamEvent => {
    if (status === "error" || status === "timeout") {
        return {
            error: { code: status === "timeout" ? "stream_timeout" : "generation_failed", message: `The generation ended with status "${status}".` },
            type: "error",
        };
    }

    return pendingRequest ? { pendingRequest, status: WAITING_ON_PERSON, type: "done" } : { status, type: "done" };
};

/**
 * Poll until the stream is terminal, yielding events as chunks land — or until
 * the read budget is spent (see the module comment).
 *
 * Chunks and status come from one read, so a terminal status is never seen
 * without the chunks written before it.
 */
export async function* pollStream(source: StreamSource, options: PollOptions = {}): AsyncGenerator<StreamEvent> {
    const wait = options.sleep ?? sleep;
    const now = options.now ?? Date.now;
    const delay = options.delay ?? streamingPollDelay;
    const maxReads = options.maxReads ?? STREAM_MAX_READS;
    const deadline = now() + (options.maxDurationMs ?? MAX_RELAY_DURATION_MS);
    let afterIndex = options.afterIndex ?? 0;
    let emptyPolls = 0;
    let reads = 0;

    while (!options.signal?.aborted) {
        const { chunks, locked, pendingRequest, status } = await source.read(afterIndex);

        if (locked) {
            yield { error: { code: "thread_locked", message: "This chat is locked." }, type: "error" };

            return;
        }

        reads += 1;
        afterIndex += chunks.length;

        for (const chunk of chunks) {
            yield* chunkToEvents(chunk);
        }

        if (TERMINAL_STREAM_STATUSES.has(status)) {
            yield terminalEvent(status, pendingRequest);

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
        await wait(delay(reads, emptyPolls));
    }
}

export interface CollectedStream {
    /** Set with `status: "waiting_on_person"`. */
    pendingRequest?: PendingRequest;
    reasoning: string;
    status: string;
    text: string;
}

/**
 * Drain a stream into one blocking completion. Its polls stretch
 * ({@link blockingPollDelay}) so the read budget spans the whole wait; running
 * out of it reads as `relay_budget`. A read that throws ends it as
 * `interrupted` with what arrived, and the caller reads the rest from the thread.
 */
export const collectStream = async (source: StreamSource, options: PollOptions = {}): Promise<CollectedStream> => {
    let text = "";
    let reasoning = "";
    let status = "unknown";
    let pendingRequest: PendingRequest | undefined;

    const events = pollStream(source, { delay: blockingPollDelay, ...options });

    try {
        for await (const event of events) {
            switch (event.type) {
                case "done": {
                    status = event.status;
                    pendingRequest = event.pendingRequest;
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
                case "reply.restart": {
                    // One text: a steered reply's two halves are joined, the boundary is for streaming consumers.
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
    } catch (error) {
        // A read failed after the run began. The caller has already started (and paid for) the turn, so it gets
        // what arrived and a status that says to read the rest from the thread, never an error to retry.
        status = INTERRUPTED;
        httpLogger.warn("[public-api] stream read failed after the run began:", error);
    }

    return { ...(pendingRequest && { pendingRequest }), reasoning, status, text };
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
