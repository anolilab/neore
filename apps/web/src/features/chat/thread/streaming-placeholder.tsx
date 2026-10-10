"use client";

/**
 * StreamingPlaceholder - Renders streaming content via the Gateway edge worker
 *
 * This component:
 * 1. Connects to the gateway's POST /v1/stream endpoint with an HMAC stream token
 * 2. Creates a minimal UIMessage from the streaming NDJSON text chunks
 * 3. Renders using the same structure as MessageItem for visual consistency
 *
 * Stream status tracking:
 * - "pending": Stream created, waiting for content
 * - "streaming": Actively receiving content
 * - "done": Stream complete
 *
 * Visibility is controlled by the parent via activeStreamId from Lunora.
 * When streaming completes, stream status is updated to "done" server-side,
 * which causes activeStreamId to become null and this component unmounts.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { StreamSpeaker } from "@neore/chat-ui/utils/stream-line";
import { parseStreamLine } from "@neore/chat-ui/utils/stream-line";
import { Message, MessageContent as MessageContentWrapper } from "@neore/ui/components/ai-elements/message";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { FC, RefObject } from "react";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { SpeakerChip } from "@/features/chat/group/speaker-label";
import type { UIMessage } from "@/lib/agent";
import { useCRPC } from "@/lib/lunora/crpc";

import MessageContent from "./message-content";

/** Approximate token count from character count (4 chars ≈ 1 token). */
const approxTokens = (text: string): number => Math.round(text.length / 4);

/** Format a duration in milliseconds to a compact string like "0.41s". */
const formatDuration = (ms: number): string => `${(ms / 1000).toFixed(2)}s`;

// Types from local streaming implementation
type StreamId = string & { __isStreamId: true };
type StreamStatus = "pending" | "streaming" | "done" | "error" | "timeout";
/** `speaker`: group chat — the participant talking now; `text`/`reasoning` are theirs only. */
type StreamBody = { reasoning: string; speaker?: StreamSpeaker; status: StreamStatus; text: string };
type StreamDelta = { reasoning: string; speaker?: StreamSpeaker; text: string };

const MAX_RECONNECT_ATTEMPTS = 3;
/** Base delay for exponential backoff (ms) */
const RECONNECT_BASE_DELAY = 1000;

/** Chunks received since the last frame, merged; `reset` when a group-chat speaker change is among them. */
interface PendingDelta extends StreamDelta {
    reset: boolean;
}

/** Applies the chunks of one frame to the shown body. */
const applyPendingDelta = (previous: StreamDelta, pending: PendingDelta): StreamDelta => {
    // Group chat: a speaker marker starts the next participant's reply. The
    // previous one is a saved message by now, so the placeholder shows only the
    // participant talking.
    if (pending.reset) {
        return { reasoning: pending.reasoning, speaker: pending.speaker, text: pending.text };
    }

    return { reasoning: previous.reasoning + pending.reasoning, speaker: previous.speaker, text: previous.text + pending.text };
};

interface FrameBatcher {
    /** Drops pending chunks; for a torn-down stream. */
    cancel: () => void;
    /** Applies pending chunks now rather than on the next frame. */
    flush: () => void;
    push: (chunk: StreamDelta) => void;
}

/**
 * Coalesces stream chunks into one `onFlush` per animation frame. A hidden tab
 * runs no frames, so its chunks wait (merged) until it is shown or `flush` runs.
 */
const createFrameBatcher = (onFlush: (pending: PendingDelta) => void): FrameBatcher => {
    let pending: PendingDelta | null = null;
    let frame: number | null = null;

    const flush = () => {
        if (frame !== null) {
            cancelAnimationFrame(frame);
            frame = null;
        }

        if (pending) {
            const delta = pending;

            pending = null;
            onFlush(delta);
        }
    };

    return {
        cancel: () => {
            if (frame !== null) {
                cancelAnimationFrame(frame);
                frame = null;
            }

            pending = null;
        },
        flush,
        push: ({ reasoning, speaker, text }) => {
            pending =
                speaker || !pending
                    ? { reasoning, reset: Boolean(speaker), speaker, text }
                    : { ...pending, reasoning: pending.reasoning + reasoning, text: pending.text + text };

            frame ??= requestAnimationFrame(flush);
        },
    };
};

/** `resume`: the gateway handed the stream over (`{ type: "resume" }`, its last line); continue in a new request. */
type StreamAttemptResult = "done" | "finished" | "failed" | "disconnected" | "resume";

const attemptStream = async (
    url: URL,
    _streamId: StreamId,
    onUpdate: (chunk: StreamDelta) => void,
    headers: Record<string, string>,
    onFirstToken?: () => void,
    lastChunkIndex?: number,
    streamToken?: string,
    signal?: AbortSignal,
): Promise<StreamAttemptResult> => {
    // `resumable`: a long relay ends with a resume marker instead of running
    // past the gateway's per-request subrequest cap (`client-stream.ts`).
    const body = { resumable: true, streamToken, ...(lastChunkIndex != null && { lastChunkIndex }) };

    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", ...headers },
        method: "POST",
        signal,
    });

    if (response.status === 205) {
        return "finished";
    }

    if (!response.ok || !response.body) {
        console.error("Failed to reach streaming endpoint", response);

        return "failed";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isFirstTokenFired = false;
    let isResumed = false;

    /** Returns false when the line is a server error, which ends this attempt. */
    const handleLine = (line: string): boolean => {
        const parsed = parseStreamLine(line);

        // Gateway may relay error objects — surface them and trigger fallback
        if (parsed.kind === "error") {
            console.error("[SSE] Server error in stream:", parsed.error);

            return false;
        }

        // The relay's last line, not a chunk: the caller continues from the
        // chunks it counted, which is the marker's `lastChunkIndex`.
        if (parsed.kind === "resume") {
            isResumed = true;

            return true;
        }

        if ((parsed.text || parsed.reasoning) && !isFirstTokenFired) {
            isFirstTokenFired = true;
            onFirstToken?.();
        }

        // Called once per relayed chunk, even an empty one: the caller counts calls
        // to resume at the right `lastChunkIndex` after a reconnect.
        onUpdate({ reasoning: parsed.reasoning, speaker: parsed.speaker, text: parsed.text });

        return true;
    };

    while (true) {
        try {
            const { done, value } = await reader.read();

            if (done) {
                // Process any remaining data in buffer
                if (buffer.trim() && !handleLine(buffer)) {
                    return "failed";
                }

                return isResumed ? "resume" : "done";
            }

            // Decode chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });

            // Process complete lines (JSON objects)
            const lines = buffer.split("\n");

            buffer = lines.pop() || ""; // Keep incomplete line in buffer

            for (const line of lines) {
                if (line.trim() && !handleLine(line)) {
                    return "failed";
                }
            }
        } catch (error) {
            console.error("[SSE] Error reading stream, will attempt reconnect", error);

            return "disconnected";
        }
    }
};

/**
 * Internal helper for starting a stream with automatic reconnection.
 * Streams from the gateway edge worker. On network failure mid-stream,
 * retries up to MAX_RECONNECT_ATTEMPTS times with exponential backoff. A
 * resume marker continues at once, from the chunks counted so far, and is not
 * a reconnect attempt. The persistent Lunora body acts as ultimate fallback via
 * useQuery. Exported for the test.
 */
export const startStreaming = async (
    url: URL,
    streamId: StreamId,
    onUpdate: (chunk: StreamDelta) => void,
    headers: Record<string, string>,
    onFirstToken?: () => void,
    onReconnecting?: (attempt: number) => void,
    streamToken?: string,
    signal?: AbortSignal,
): Promise<boolean> => {
    let attempt = 0;
    let chunkCount = 0;

    const trackingOnUpdate = (chunk: StreamDelta) => {
        chunkCount += 1;
        onUpdate(chunk);
    };

    while (attempt <= MAX_RECONNECT_ATTEMPTS) {
        if (signal?.aborted) {
            return false;
        }

        try {
            const result = await attemptStream(
                url,
                streamId,
                trackingOnUpdate,
                headers,
                onFirstToken,
                chunkCount > 0 ? chunkCount : undefined,
                streamToken,
                signal,
            );

            if (result === "done") {
                return true;
            }

            if (result === "finished") {
                return false;
            }

            if (result === "failed") {
                return false;
            }

            if (result === "resume") {
                continue;
            }
            // result === "disconnected" — retry
        } catch {
            // Network error during fetch itself
        }

        if (signal?.aborted) {
            return false;
        }

        attempt += 1;

        if (attempt > MAX_RECONNECT_ATTEMPTS) {
            console.error(`[SSE] Gave up reconnecting after ${MAX_RECONNECT_ATTEMPTS} attempts`);

            return false;
        }

        const delay = RECONNECT_BASE_DELAY * 2 ** (attempt - 1);

        console.warn(`[SSE] Stream disconnected, reconnecting in ${delay}ms (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}, chunkOffset=${chunkCount})`);
        onReconnecting?.(attempt);
        await new Promise((resolve) => {
            setTimeout(resolve, delay);
        });
    }

    return false;
};

/**
 * React hook for persistent text streaming via the gateway edge worker.
 * Inlined from persistent-text-streaming/react.
 */
const useStream = (
    /** Undefined when there is no gateway to stream from; the hook then reads the persisted body only. */
    streamUrl: URL | undefined,
    driven: boolean,
    streamId: StreamId | undefined,
    options: {
        headers?: Record<string, string>;
        onFirstToken?: () => void;
        /** HMAC stream token for gateway auth */
        streamToken?: string;
    },
): StreamBody & { isReconnecting?: boolean } => {
    const crpc = useCRPC();
    const [streamEnded, setStreamEnded] = useState<boolean | null>(null);
    const [isReconnecting, setIsReconnecting] = useState(false);
    const streamStarted = useRef(false);
    const onFirstTokenRef = useRef(options.onFirstToken);

    // Update ref after render to avoid React Compiler flagging ref mutations during render
    useLayoutEffect(() => {
        onFirstTokenRef.current = options.onFirstToken;
    });

    // Read the persisted body whenever the stream has not ended and we are not
    // driving a live stream ourselves.
    const isUsePersistence = streamEnded === false || !driven;

    const { data: persistentBody } = useQuery(
        // `StreamId` is the local brand for a `persistentStreams` id — the value comes
        // straight from `getActiveStreamForThread`.
        crpc.chat.streaming.getStreamBody.queryOptions(isUsePersistence && streamId ? { streamId: streamId as unknown as Id<"persistentStreams"> } : skipToken),
    );
    const [streamBody, setStreamBody] = useState<StreamDelta>({ reasoning: "", text: "" });

    // Owns the in-flight stream so it can be torn down on unmount. Deliberately NOT
    // aborted when the effect below re-runs: `streamStarted` makes that a no-op, and
    // `options.headers` is a fresh object on most renders.
    const streamAbortRef = useRef<AbortController | null>(null);
    const frameBatcherRef = useRef<FrameBatcher | null>(null);

    useEffect(
        () => () => {
            streamAbortRef.current?.abort();
            frameBatcherRef.current?.cancel();
        },
        [],
    );

    useEffect(() => {
        const token = options?.streamToken;
        const headers = options?.headers ?? {};

        if (driven && streamUrl && token && streamId && !streamStarted.current) {
            streamStarted.current = true;

            const controller = new AbortController();

            streamAbortRef.current = controller;

            // One state update per frame, however many chunks landed in it: each
            // update re-renders (and re-parses) the whole markdown of the reply.
            const batcher = createFrameBatcher((pending) => {
                setStreamBody((previous) => applyPendingDelta(previous, pending));
                setIsReconnecting(false);
            });

            frameBatcherRef.current = batcher;

            const appendChunk = (chunk: StreamDelta) => {
                batcher.push(chunk);
            };

            const handleFirstToken = () => onFirstTokenRef.current?.();

            // Flushed first, so a frame still pending cannot clear the flag again.
            const handleReconnecting = () => {
                batcher.flush();
                setIsReconnecting(true);
            };

            void (async () => {
                const success = await startStreaming(streamUrl, streamId, appendChunk, headers, handleFirstToken, handleReconnecting, token, controller.signal);

                if (controller.signal.aborted) {
                    batcher.cancel();

                    return;
                }

                // The last chunks must be on screen before the stream reads as ended.
                batcher.flush();
                setIsReconnecting(false);
                setStreamEnded(success);
            })();
        }
    }, [driven, streamUrl, streamId, options?.headers, options?.streamToken]);

    const body = useMemo<StreamBody & { isReconnecting?: boolean }>(() => {
        if (persistentBody) {
            // The generated return type for `getStreamBody` points at a module path that
            // does not exist in `_generated`, so it lands as an empty object here. The
            // backend returns the shape declared as `StreamBody` above.
            return { ...(persistentBody as StreamBody), isReconnecting: false };
        }

        let status: StreamStatus;

        if (streamEnded === null) {
            status = streamBody.text.length > 0 || streamBody.reasoning.length > 0 ? "streaming" : "pending";
        } else {
            status = streamEnded ? "done" : "error";
        }

        return {
            isReconnecting,
            reasoning: streamBody.reasoning,
            speaker: streamBody.speaker,
            status: status as StreamStatus,
            text: streamBody.text,
        };
    }, [persistentBody, streamBody, streamEnded, isReconnecting]);

    return body;
};

/** Max reconnection attempts before giving up */

/**
 * Group chat: tells screen-reader users when the next participant starts
 * speaking. Only the change is announced — the name, not the streamed text.
 */
const SpeakerAnnouncement: FC<{ name: string | undefined }> = ({ name }) => (
    <span aria-live="polite" className="sr-only" role="status">
        {name ? <Trans>{name} is responding</Trans> : null}
    </span>
);

interface Metrics {
    approxTokenCount: number;
    elapsedMs: number;
    tokPerSec: number | null;
    ttftMs: number | null;
}

interface StreamingMetricsBarProps {
    firstTokenTimeRef: RefObject<number | null>;
    isReconnecting?: boolean;
    isStreaming: boolean;
    startTimeRef: RefObject<number | null>;
    /** The reply so far, read on each tick rather than passed, so a token does not restart the interval. */
    textRef: RefObject<string>;
}

/**
 * Timing metrics under a streaming reply. Its own component so the 100ms tick
 * re-renders only this bar, not the reply's markdown.
 */
const StreamingMetricsBar: FC<StreamingMetricsBarProps> = ({ firstTokenTimeRef, isReconnecting, isStreaming, startTimeRef, textRef }) => {
    const { t } = useLingui();
    // Computed in an effect/interval to keep the render path pure.
    const [metrics, setMetrics] = useState<Metrics>({ approxTokenCount: 0, elapsedMs: 0, tokPerSec: null, ttftMs: null });

    useEffect(() => {
        const update = () => {
            const start = startTimeRef.current;

            if (start === null) {
                return;
            }

            const now = performance.now();
            const elapsed = now - start;
            const ttft = firstTokenTimeRef.current === null ? null : firstTokenTimeRef.current - start;
            const tokenCount = approxTokens(textRef.current);
            const genDuration = ttft === null ? null : elapsed - ttft;
            const tps = genDuration !== null && genDuration > 0 && tokenCount > 0 ? (tokenCount / genDuration) * 1000 : null;

            setMetrics({ approxTokenCount: tokenCount, elapsedMs: elapsed, tokPerSec: tps, ttftMs: ttft });
        };

        if (!isStreaming) {
            update();

            return undefined;
        }

        const intervalId = setInterval(update, 100);

        return () => clearInterval(intervalId);
    }, [firstTokenTimeRef, isStreaming, startTimeRef, textRef]);

    const { approxTokenCount, elapsedMs, tokPerSec, ttftMs } = metrics;

    if (isReconnecting) {
        return (
            <div aria-live="polite" className="mt-1 flex items-center gap-2 text-xs text-amber-500 dark:text-amber-400" role="status">
                <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-amber-500" />
                <span>{t`Reconnecting…`}</span>
            </div>
        );
    }

    if (isStreaming && ttftMs !== null) {
        return (
            <div className="mt-1 flex items-center gap-2 text-xs text-gray-400 dark:text-gray-500">
                {tokPerSec !== null && <span>{t`${tokPerSec.toFixed(1)} tokens/s`}</span>}
                {approxTokenCount > 0 && <span>{t`~${approxTokenCount} tokens`}</span>}
                <span>{t`First token ${formatDuration(ttftMs)}`}</span>
            </div>
        );
    }

    if (isStreaming) {
        return (
            <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                <span>{t`${formatDuration(elapsedMs)} elapsed`}</span>
            </div>
        );
    }

    return null;
};

interface StreamingPlaceholderProps {
    className?: string;
    /** Render a compact version (no message wrapper chrome) for use in comparison columns */
    compact?: boolean;
    /** Gateway URL for edge streaming. Omit to read the persisted stream body instead. */
    gatewayUrl?: string;
    maxWidth?: string;
    streamId: string;
    /** HMAC stream token for gateway auth. Omit to read the persisted stream body instead. */
    streamToken?: string;
}

export const StreamingPlaceholder: FC<StreamingPlaceholderProps> = memo(({ className, compact, gatewayUrl, maxWidth = "65ch", streamId, streamToken }) => {
    // Gateway edge streaming URL. Absent when the caller has no stream token for this
    // stream (comparison columns), in which case the persisted body is polled instead.
    // Relative join: `gatewayUrl` may carry a path (`/llm-gateway` behind the dev
    // proxy), which an absolute "/v1/stream" would silently drop.
    const sseUrl = useMemo(() => {
        if (!gatewayUrl) {
            return undefined;
        }

        const base = gatewayUrl.endsWith("/") ? gatewayUrl : `${gatewayUrl}/`;

        return new URL("v1/stream", base);
    }, [gatewayUrl]);
    const isDriven = Boolean(gatewayUrl && streamToken);

    // Timing refs — initialized in layout effects to avoid impure calls during render
    const startTimeRef = useRef<number | null>(null);
    const firstTokenTimeRef = useRef<number | null>(null);

    // Initialize the start time once after mount (avoids performance.now() during render)
    useLayoutEffect(() => {
        if (startTimeRef.current === null) {
            startTimeRef.current = performance.now();
        }
    }, []);

    // Stable creation time for the synthetic UIMessage (computed once)
    const [creationTime] = useState(() => Date.now());

    const handleFirstToken = useCallback(() => {
        if (firstTokenTimeRef.current === null) {
            firstTokenTimeRef.current = performance.now();
        }
    }, []);

    // Use the streaming hook - isDriven=true to trigger the gateway SSE connection
    const { isReconnecting, reasoning, speaker, status, text } = useStream(sseUrl, isDriven, streamId as StreamId, {
        onFirstToken: handleFirstToken,
        streamToken,
    });

    // Consider streaming active if status is pending, streaming, or undefined (initial state)
    const isStreaming = status !== "done";
    const displayText = text || "";
    const displayReasoning = reasoning || "";

    // Keep a stable ref to displayText so the metrics interval doesn't need to restart on each token
    const displayTextRef = useRef(displayText);

    useLayoutEffect(() => {
        displayTextRef.current = displayText;
    });

    // Create a minimal UIMessage for MessageContent
    // Including required fields from the UIMessage type
    const streamingMessage = useMemo((): UIMessage => {
        return {
            _creationTime: creationTime,
            id: `streaming-${streamId}`,
            key: `streaming-${streamId}`,
            order: Number.MAX_SAFE_INTEGER,
            // Reasoning first, and only non-empty parts: chat-ui treats a reasoning part as
            // still streaming only while it is the LAST part, so the panel collapses as
            // soon as answer text arrives.
            parts: [
                ...(displayReasoning ? [{ text: displayReasoning, type: "reasoning" }] : []),
                ...(displayText ? [{ text: displayText, type: "text" }] : []),
            ] as UIMessage["parts"],
            role: "assistant",
            status: isStreaming ? "streaming" : "success",
            stepOrder: 0,
            text: displayText,
        };
    }, [streamId, isStreaming, displayText, displayReasoning, creationTime]);

    // Hide if stream is done AND we have no content (error case)
    // Normal case: parent unmounts us when activeStreamId becomes null
    if (status === "done" && !displayText && !displayReasoning) {
        return null;
    }

    const metricsBar = (
        <StreamingMetricsBar
            firstTokenTimeRef={firstTokenTimeRef}
            isReconnecting={isReconnecting}
            isStreaming={isStreaming}
            startTimeRef={startTimeRef}
            textRef={displayTextRef}
        />
    );

    if (compact) {
        return (
            <div className={cn("streaming-placeholder-compact", className)}>
                <MessageContent isStreaming={isStreaming} message={streamingMessage} />
                {metricsBar}
            </div>
        );
    }

    return (
        <div
            className={cn("message-item", className)}
            data-message-role="assistant"
            data-streaming-placeholder="true"
            style={{ "--thread-max-width": maxWidth } as React.CSSProperties}
        >
            <Message className="relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2 pb-6" from="assistant">
                <span className="sr-only">
                    <Trans>Assistant Reply:</Trans>{" "}
                </span>
                <MessageContentWrapper className="text-foreground col-span-2 col-start-2 row-start-1 leading-7 wrap-break-word dark:text-white">
                    {speaker && <SpeakerChip className="mb-1" name={speaker.name} />}
                    <MessageContent isStreaming={isStreaming} message={streamingMessage} />
                    {metricsBar}
                </MessageContentWrapper>
            </Message>
            <SpeakerAnnouncement name={isStreaming ? speaker?.name : undefined} />
        </div>
    );
});

StreamingPlaceholder.displayName = "StreamingPlaceholder";

/**
 * ThinkingPlaceholder - Shows "Thinking..." when regenerating but no stream exists yet
 *
 * This is used during the optimistic regenerating state before the server creates a stream.
 */
interface ThinkingPlaceholderProps {
    className?: string;
    maxWidth?: string;
}

export const ThinkingPlaceholder: FC<ThinkingPlaceholderProps> = memo(({ className, maxWidth = "65ch" }) => (
    <div
        className={cn("message-item", className)}
        data-message-role="assistant"
        data-thinking-placeholder="true"
        style={{ "--thread-max-width": maxWidth } as React.CSSProperties}
    >
        <Message className="relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2 pb-6" from="assistant">
            <span className="sr-only">
                <Trans>Assistant Reply:</Trans>{" "}
            </span>
            <MessageContentWrapper className="text-foreground col-span-2 col-start-2 row-start-1 leading-7 wrap-break-word dark:text-white">
                <span className="animate-pulse text-gray-400">
                    <Trans>Thinking...</Trans>
                </span>
            </MessageContentWrapper>
        </Message>
    </div>
));

ThinkingPlaceholder.displayName = "ThinkingPlaceholder";
