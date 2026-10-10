"use client";

import { blankUIMessage, deriveUIMessagesFromTextStreamParts, getParts, updateFromUIMessageChunks } from "@neore/backend/agent/deltas";
import type { UIMessage } from "@neore/backend/agent/ui-messages";
import type { UIDataTypes, UIMessageChunk, UITools } from "ai";
import { useEffect, useMemo, useRef, useState } from "react";

import type { StreamQuery, StreamQueryArgs } from "./types";
import useDeltaStreams from "./use-delta-streams";

// Debug streaming performance
const IS_DEBUG_STREAMING = false; // Disabled for performance - set to true for debugging

// Polyfill structuredClone to support readUIMessageStream on ReactNative
if (!("structuredClone" in globalThis)) {
    void import("@ungap/structured-clone").then(({ default: structuredClone }) =>
        Object.defineProperty(globalThis, "structuredClone", { configurable: true, value: structuredClone, writable: true }),
    );
}

/**
 * A hook that fetches streaming messages from a thread and converts them to UIMessages
 * using AI SDK's readUIMessageStream.
 * This ONLY returns streaming UIMessages. To get both full and streaming messages,
 * use `useUIMessages`.
 * @param query The query to use to fetch messages.
 * It must take as arguments `{ threadId, paginationOpts, streamArgs }` and
 * return a `streams` object returned from `agent.syncStreams`.
 * @param args The arguments to pass to the query other than `paginationOpts`
 * and `streamArgs`. So `{ threadId }` at minimum, plus any other arguments that
 * you want to pass to the query.
 * @returns One entry per in-flight stream, each already materialized into a
 * UIMessage; full (persisted) messages are not included.
 */
const useStreamingUIMessages = <
    Metadata = unknown,
    DataParts extends UIDataTypes = UIDataTypes,
    Tools extends UITools = UITools,
    Query extends StreamQuery<any> = StreamQuery<object>,
>(
    query: Query,
    args: StreamQueryArgs<Query> | "skip",
    options?: {
        skipStreamIds?: string[];
        startOrder?: number;
    },
): UIMessage<Metadata, DataParts, Tools>[] | undefined => {
    const [messageState, setMessageState] = useState<
        Record<
            string,
            {
                cursor: number;
                uiMessage: UIMessage<Metadata, DataParts, Tools>;
            }
        >
    >({});

    const messageStateRef = useRef(messageState);

    // Synced after commit — writing a ref during render is not allowed. Declared
    // before the delta effect below, so it always runs first on the same commit.
    useEffect(() => {
        messageStateRef.current = messageState;
    }, [messageState]);

    const streams = useDeltaStreams(query, args, options);

    const threadId = args === "skip" ? undefined : args.threadId;

    const processingRef = useRef(false);

    useEffect(() => {
        if (!streams) {
            return;
        }

        // Check if there are any new deltas beyond the cursors
        let hasNewDeltas = false;

        for (const stream of streams) {
            const lastDelta = stream.deltas.at(-1);
            const cursor = messageStateRef.current[stream.streamMessage.streamId]?.cursor;

            if (!cursor || (lastDelta && lastDelta.start >= cursor)) {
                hasNewDeltas = true;
                break;
            }
        }

        if (!hasNewDeltas) {
            return;
        }

        // Debug: Log delta processing (only when enabled)
        if (IS_DEBUG_STREAMING) {
            const totalDeltas = streams.reduce((accumulator, s) => accumulator + s.deltas.length, 0);

            console.log(`[STREAM_DEBUG][useStreamingUIMessages] Processing deltas`, {
                streamCount: streams.length,
                streams: streams.map((s) => {
                    return {
                        cursor: messageStateRef.current[s.streamMessage.streamId]?.cursor ?? 0,
                        deltaCount: s.deltas.length,
                        format: s.streamMessage.format,
                        streamId: s.streamMessage.streamId,
                    };
                }),
                timestamp: Date.now(),
                totalDeltas,
            });
        }

        // Use microtask for immediate processing without blocking the main thread
        // This is faster than setTimeout/requestAnimationFrame for streaming updates
        const processDeltas = async () => {
            if (processingRef.current) {
                return;
            }

            processingRef.current = true;

            // Split out of a `try/finally` (which the React Compiler cannot lower)
            // — an async function never throws synchronously, so `then(ok, fail)`
            // resets the re-entrancy guard on every path exactly as `finally` did.
            const newMessageState: Record<
                string,
                {
                    cursor: number;
                    uiMessage: UIMessage<Metadata, DataParts, Tools>;
                }
            > = {};

            // A named sibling rather than an inline `map` callback: inlining it
            // nests five function scopes deep, which is unreadable and linted.
            const processStream = async ({ deltas, streamMessage }: NonNullable<typeof streams>[number]) => {
                const { cursor, parts } = getParts<UIMessageChunk>(deltas, 0);

                let uiMessage: UIMessage<Metadata, DataParts, Tools>;

                if (streamMessage.format === "UIMessageChunk") {
                    // Use the existing function to update from chunks
                    uiMessage = (await updateFromUIMessageChunks(blankUIMessage(streamMessage, threadId), parts)) as unknown as UIMessage<
                        Metadata,
                        DataParts,
                        Tools
                    >;
                } else {
                    const [uiMessages] = deriveUIMessagesFromTextStreamParts(threadId, [streamMessage], [], deltas);

                    uiMessage = uiMessages[0] as unknown as UIMessage<Metadata, DataParts, Tools>;
                }

                newMessageState[streamMessage.streamId] = {
                    cursor,
                    uiMessage,
                };
            };

            const run = async () => {
                // Process streams in parallel for better performance
                await Promise.all(Array.from(streams, processStream));

                setMessageState(newMessageState);
            };

            const releaseGuard = () => {
                processingRef.current = false;
            };

            await run()
                .then(releaseGuard)
                .catch((error: unknown) => {
                    releaseGuard();

                    throw error;
                });
        };

        // Use queueMicrotask for immediate processing
        queueMicrotask(() => {
            void processDeltas();
        });
    }, [streams, threadId]);

    return useMemo(() => {
        if (!streams) {
            return undefined;
        }

        return streams.map(({ streamMessage }) => messageState[streamMessage.streamId]?.uiMessage).filter((uiMessage) => uiMessage !== undefined);
    }, [messageState, streams]);
};

export default useStreamingUIMessages;
