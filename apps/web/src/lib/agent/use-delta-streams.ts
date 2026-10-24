import type { ArgsOf } from "@lunora/react";
import { useQuery } from "@lunora/react";
import { sorted } from "@neore/backend/agent/shared";
import type { SyncStreamsReturnValue } from "@neore/backend/agent/types";
import type { StreamArgs, StreamDelta, StreamMessage } from "@neore/backend/agent/validators";
import { useState } from "react";

import { shardOptionsFor } from "@/lib/lunora/shard-routing";
import { withUnlockProof } from "@/lib/lunora/unlock-proofs";

import type { StreamQuery, StreamQueryArgs } from "./types";

("use client");

// Debug streaming performance - set to true for debugging
const IS_DEBUG_STREAMING = false;

const useDeltaStreams = <Query extends StreamQuery<any> = StreamQuery<object>>(
    query: Query,
    args: StreamQueryArgs<Query> | "skip",
    options?: {
        skipStreamIds?: string[];
        startOrder?: number;
    },
): { deltas: StreamDelta[]; streamMessage: StreamMessage }[] | undefined => {
    // We hold onto and modify state directly to avoid re-running unnecessarily.
    const [state] = useState<{
        deltaStreams:
            | {
                  deltas: StreamDelta[];
                  streamMessage: StreamMessage;
              }[]
            | undefined;
        startOrder: number;
        threadId: string | undefined;
    }>({
        deltaStreams: undefined,
        startOrder: options?.startOrder ?? 0,
        threadId: args === "skip" ? undefined : args.threadId,
    });
    const [cursors, setCursors] = useState<Record<string, number>>({});

    if (args !== "skip" && state.threadId !== args.threadId) {
        state.threadId = args.threadId;
        state.deltaStreams = undefined;
        state.startOrder = options?.startOrder ?? 0;
        setCursors({});
    }

    if (state.deltaStreams?.length || (options?.startOrder && options.startOrder < state.startOrder)) {
        const cacheFriendlyStartOrder = options?.startOrder
            ? // round down to the nearest 10 for some cache benefits
              options.startOrder - (options.startOrder % 10)
            : 0;

        if (cacheFriendlyStartOrder !== state.startOrder) {
            state.startOrder = cacheFriendlyStartOrder;
        }
    }

    // A shared thread's streams live on its owner's shard (`lib/lunora/shard-routing.ts`).
    const shardOptions = shardOptionsFor(args);

    // Get all the active streams
    const streamList = useQuery(
        query,
        args === "skip"
            ? args
            : withUnlockProof({
                  ...args,
                  streamArgs: {
                      kind: "list",
                      startOrder: state.startOrder,
                  } as StreamArgs,
              } as ArgsOf<Query>),
        shardOptions,
    ) as { streams: Extract<SyncStreamsReturnValue, { kind: "list" }> } | undefined;

    const skippedStreamIds = new Set(options?.skipStreamIds);

    let streamMessages: StreamMessage[] | undefined;

    if (args !== "skip") {
        streamMessages = streamList
            ? sorted(
                  streamList.streams.messages.filter(
                      ({ order, streamId }) => !skippedStreamIds.has(streamId) && (!options?.startOrder || order >= options.startOrder),
                  ),
              )
            : state.deltaStreams?.map(({ streamMessage }) => streamMessage);
    }

    // Get the deltas for all the active streams, if any.
    const cursorQuery = useQuery(
        query,
        args === "skip" || !streamMessages?.length
            ? ("skip" as const)
            : withUnlockProof({
                  ...args,
                  streamArgs: {
                      cursors: streamMessages.map(({ streamId }) => {
                          return {
                              cursor: cursors[streamId] ?? 0,
                              streamId,
                          };
                      }),
                      kind: "deltas",
                  } as StreamArgs,
              } as ArgsOf<Query>),
        shardOptions,
    ) as { streams: Extract<SyncStreamsReturnValue, { kind: "deltas" }> } | undefined;

    const newDeltas = cursorQuery?.streams.deltas;

    // Debug: Log when new deltas arrive
    if (IS_DEBUG_STREAMING && newDeltas && newDeltas.length > 0) {
        console.log(`[STREAM_DEBUG][useDeltaStreams] New deltas received from query`, {
            deltaCount: newDeltas.length,
            deltas: newDeltas.slice(0, 3).map((d) => {
                return {
                    end: d.end,
                    partLength: d.parts?.length ?? 0,
                    start: d.start,
                    streamId: d.streamId,
                };
            }),
            timestamp: Date.now(),
        });
    }

    if (streamMessages) {
        const newDeltasByStreamId = new Map<string, StreamDelta[]>();
        // Streams whose deltas left a hole: drop what we hold and re-fetch from the start.
        const resetStreamIds = new Set<string>();

        if (newDeltas?.length) {
            for (const delta of newDeltas) {
                // A stream with no cursor yet was queried from 0, so its first delta must start there too.
                const oldCursor = cursors[delta.streamId] ?? 0;

                if (resetStreamIds.has(delta.streamId) || delta.start < oldCursor) {
                    continue;
                }

                const existing = newDeltasByStreamId.get(delta.streamId);
                const expectedStart = existing ? existing.at(-1)?.end : oldCursor;
                const isGap = expectedStart !== delta.start;

                if (isGap) {
                    if (import.meta.env.DEV) {
                        console.warn(`Gap found in deltas for ${delta.streamId}: expected ${expectedStart}, got ${delta.start}; refetching`);
                    }

                    newDeltasByStreamId.delete(delta.streamId);
                    resetStreamIds.add(delta.streamId);
                } else if (existing) {
                    existing.push(delta);
                } else {
                    newDeltasByStreamId.set(delta.streamId, [delta]);
                }
            }
        }

        const newCursors: Record<string, number> = {};
        let isCursorsChanged = false;

        for (const { streamId } of streamMessages) {
            const cursor = resetStreamIds.has(streamId) ? 0 : (newDeltasByStreamId.get(streamId)?.at(-1)?.end ?? cursors[streamId]);

            if (cursor !== undefined) {
                newCursors[streamId] = cursor;

                if (cursors[streamId] !== cursor) {
                    isCursorsChanged = true;
                }
            }
        }

        // Also check if any streams were removed from cursors
        for (const streamId of Object.keys(cursors)) {
            if (!Object.hasOwn(newCursors, streamId)) {
                isCursorsChanged = true;
                break;
            }
        }

        if (isCursorsChanged) {
            setCursors(newCursors);
        }

        // we defensively create a new object so object identity matches contents
        state.deltaStreams = streamMessages.map((streamMessage) => {
            const { streamId } = streamMessage;
            const old = state.deltaStreams?.find((ds) => ds.streamMessage.streamId === streamId);
            const streamDeltas = newDeltasByStreamId.get(streamId);

            if (resetStreamIds.has(streamId)) {
                return { deltas: [], streamMessage };
            }

            if (!streamDeltas && streamMessage === old?.streamMessage) {
                return old;
            }

            return {
                deltas: [...(old?.deltas ?? []), ...(streamDeltas ?? [])],
                streamMessage,
            };
        });
    }

    return state.deltaStreams;
};

export default useDeltaStreams;
