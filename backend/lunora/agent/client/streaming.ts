import {
    type AsyncIterableStream,
    type ChunkDetector,
    smoothStream,
    type StreamTextTransform,
    type TextStreamPart,
    type ToolSet,
    type UIMessageChunk,
} from "ai";
import { v } from "lunorash/server";

import { api } from "../../_generated/api";
import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import {
    type ProviderOptions,
    type StreamArgs,
    type StreamDelta,
    type StreamMessage,
    vMessageDoc as vMessageDocument,
    vPaginationResultFields,
    vStreamDelta,
    vStreamMessage,
} from "../validators";
import type { ActionCtx as ActionContext, AgentComponent, MutationCtx as MutationContext, QueryCtx as QueryContext, SyncStreamsReturnValue } from "./types";

export const vStreamMessagesReturnValue = v.object({
    ...vPaginationResultFields(vMessageDocument),
    streams: v.optional(
        v.union(
            v.object({ kind: v.literal("list"), messages: v.array(vStreamMessage) }),
            v.object({ deltas: v.array(vStreamDelta), kind: v.literal("deltas") }),
        ),
    ),
});

/**
 * A function that handles fetching stream deltas, used with the React hooks
 * `useThreadMessages` or `useStreamingThreadMessages`.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param component The agent component, usually `components.agent`.
 * @param args.threadId The thread to sync streams for.
 * @param args.streamArgs The stream arguments with per-stream cursors.
 * @returns The deltas for each stream from their existing cursor.
 */
export async function syncStreams(
    ctx: QueryContext | MutationContext | ActionContext,
    component: AgentComponent,
    {
        includeStatuses,
        streamArgs,
        threadId,
    }: {
        // By default, only streaming messages are included.
        includeStatuses?: ("streaming" | "finished" | "aborted")[];
        streamArgs?: StreamArgs;
        threadId: string;
    },
): Promise<SyncStreamsReturnValue | undefined> {
    if (!streamArgs) {
        return undefined;
    }

    if (streamArgs.kind === "list") {
        return {
            kind: "list",
            messages: await listStreams(ctx, component, {
                includeStatuses,
                startOrder: streamArgs.startOrder,
                threadId,
            }),
        };
    }

    return {
        deltas: await ctx.runQuery(api.agent.streams.listDeltas, {
            cursors: streamArgs.cursors.map((c) => {
                return { ...c, streamId: c.streamId as Id<"streamingMessages"> };
            }),
            threadId: threadId as Id<"threads">,
        }),
        kind: "deltas",
    };
}

export async function abortStream(
    context: MutationContext | ActionContext,
    _component: AgentComponent,
    args: { reason: string } & ({ streamId: string } | { order: number; threadId: string }),
): Promise<boolean> {
    if ("streamId" in args) {
        return await context.runMutation(internal.agent.streams.abort, {
            reason: args.reason,
            streamId: args.streamId as Id<"streamingMessages">,
        });
    }

    return await context.runMutation(internal.agent.streams.abortByOrder, {
        order: args.order,
        reason: args.reason,
        threadId: args.threadId as Id<"threads">,
    });
}

/**
 * List the streaming messages for a thread.
 * @param ctx A ctx object from a query, mutation, or action.
 * @param args.threadId The thread to list streams for.
 * @param args.startOrder The order of the messages in the thread to start listing from.
 * @param args.includeStatuses The statuses to include in the list.
 * @returns The streams for the thread.
 */
export async function listStreams(
    ctx: QueryContext | MutationContext | ActionContext,
    _component: AgentComponent,
    {
        includeStatuses,
        startOrder,
        threadId,
    }: {
        includeStatuses?: ("streaming" | "finished" | "aborted")[];
        startOrder?: number;
        threadId: string;
    },
): Promise<StreamMessage[]> {
    return ctx.runQuery(api.agent.streams.list, {
        startOrder,
        statuses: includeStatuses,
        threadId: threadId as Id<"threads">,
    });
}

export type StreamingOptions = {
    /**
     * The minimum granularity of deltas to save.
     * Note: this is not a guarantee that every delta will be exactly one line.
     * E.g. if "line" is specified, it won't save any deltas until it encounters
     * a newline character.
     * Defaults to a regex that chunks by punctuation followed by whitespace.
     */
    chunking?: "word" | "line" | RegExp | ChunkDetector;

    /**
     * If set to true, this will return immediately, as it would if you weren't
     * saving the deltas. Otherwise, the call will "consume" the stream with
     * .consumeStream(), which waits for the stream to finish before returning.
     *
     * When saving deltas, you're often not interactin with the stream otherwise.
     */
    returnImmediately?: boolean;

    /**
     * The minimum number of milliseconds to wait between saving deltas.
     * Defaults to 250.
     */
    throttleMs?: number;
};
export const DEFAULT_STREAMING_OPTIONS = {
    // This chunks by sentences / clauses. Punctuation followed by whitespace.
    chunking: /[\p{P}\s]/u,
    returnImmediately: false,
    throttleMs: 0, // No batching - stream immediately
} satisfies StreamingOptions;

/**
 * @param options The options passed to `agent.streamText` to decide whether to
 * save deltas while streaming.
 * @param existing The transforms passed to `agent.streamText` to merge with.
 * @returns The merged transforms to pass to the underlying `streamText` call.
 */
export function mergeTransforms<TOOLS extends ToolSet>(
    options: boolean | { chunking?: StreamingOptions["chunking"] } | undefined,
    existing: StreamTextTransform<TOOLS> | StreamTextTransform<TOOLS>[] | undefined,
) {
    if (!options) {
        return existing;
    }

    const chunking = typeof options === "boolean" ? DEFAULT_STREAMING_OPTIONS.chunking : options.chunking;
    let transforms: StreamTextTransform<TOOLS>[];

    if (Array.isArray(existing)) {
        transforms = existing;
    } else {
        transforms = existing ? [existing] : [];
    }

    transforms.push(smoothStream({ chunking, delayInMs: null }));

    return transforms;
}

/**
 * DeltaStreamer can be used to save a stream of "parts" by writing
 * batches of them in "deltas" to the database so clients can subscribe
 * (using the syncStreams utility and client hooks) and re-hydrate the stream.
 * You can optionally compress the parts, e.g. concatenating text deltas, to
 * optimize the data in transit.
 */
export class DeltaStreamer<T> {
    streamId: string | undefined;

    public readonly config: {
        compress: ((parts: T[]) => T[]) | null;
        onAsyncAbort: (reason: string) => Promise<void>;
        throttleMs: number;
    };

    #nextParts: T[] = [];

    #latestWrite = 0;

    #ongoingWrite: Promise<void> | undefined;

    #cursor = 0;

    public abortController: AbortController;

    constructor(
        public readonly component: AgentComponent,
        public readonly context: MutationContext | ActionContext,
        config: {
            abortSignal: AbortSignal | undefined;
            compress: ((parts: T[]) => T[]) | null;
            onAsyncAbort: (reason: string) => Promise<void>;
            throttleMs: number | undefined;
        },
        public readonly metadata: {
            agentName?: string;
            format: "UIMessageChunk" | "TextStreamPart" | undefined;
            model?: string;
            order: number;
            provider?: string;
            providerOptions?: ProviderOptions;
            stepOrder: number;
            threadId: string;
            userId?: string;
        },
    ) {
        this.config = {
            compress: config.compress,
            onAsyncAbort: config.onAsyncAbort,
            throttleMs: config.throttleMs ?? DEFAULT_STREAMING_OPTIONS.throttleMs,
        };
        this.#nextParts = [];
        this.abortController = new AbortController();

        if (config.abortSignal) {
            config.abortSignal.addEventListener("abort", async () => {
                if (this.abortController.signal.aborted) {
                    return;
                }

                if (this.streamId) {
                    this.abortController.abort();
                    await this.#ongoingWrite;
                    await this.context.runMutation(internal.agent.streams.abort, {
                        reason: "abortSignal",
                        streamId: this.streamId as Id<"streamingMessages">,
                    });
                }
            });
        }
    }

    // Avoid race conditions by only creating once
    #creatingStreamIdPromise: Promise<string> | undefined;

    public async getStreamId(): Promise<string> {
        if (this.streamId) {
            return this.streamId;
        }

        if (this.#creatingStreamIdPromise) {
            return this.#creatingStreamIdPromise;
        }

        this.#creatingStreamIdPromise = this.context.runMutation(internal.agent.streams.create, {
            ...this.metadata,
            threadId: this.metadata.threadId as Id<"threads">,
        });
        this.streamId = await this.#creatingStreamIdPromise;

        return this.streamId;
    }

    public async addParts(parts: T[]) {
        if (this.abortController.signal.aborted) {
            return;
        }

        await this.getStreamId();
        this.#nextParts.push(...parts);

        if (!this.#ongoingWrite && Date.now() - this.#latestWrite >= this.config.throttleMs) {
            this.#ongoingWrite = this.#sendDelta();
        }
    }

    public async consumeStream(stream: AsyncIterableStream<T>) {
        for await (const chunk of stream) {
            await this.addParts([chunk]);
        }

        await this.finish();
    }

    async #sendDelta() {
        if (this.abortController.signal.aborted) {
            return;
        }

        const delta = this.#createDelta();

        if (!delta) {
            return;
        }

        this.#latestWrite = Date.now();

        try {
            const success = await this.context.runMutation(internal.agent.streams.addDelta, {
                ...delta,
                streamId: delta.streamId as Id<"streamingMessages">,
            });

            if (!success) {
                await this.config.onAsyncAbort("async abort");
                this.abortController.abort();

                return;
            }
        } catch (error) {
            await this.config.onAsyncAbort(error instanceof Error ? error.message : "unknown error");
            this.abortController.abort();
            throw error;
        }

        // Now that we've sent the delta, check if we need to send another one.
        // When there is more to send we go again immediately with the accumulated
        // deltas; otherwise there is no write in flight.
        this.#ongoingWrite = this.#nextParts.length > 0 && Date.now() - this.#latestWrite >= this.config.throttleMs ? this.#sendDelta() : undefined;
    }

    #createDelta(): StreamDelta | undefined {
        if (this.#nextParts.length === 0) {
            return undefined;
        }

        const start = this.#cursor;
        const end = start + this.#nextParts.length;

        this.#cursor = end;
        const parts = this.config.compress ? this.config.compress(this.#nextParts) : this.#nextParts;

        this.#nextParts = [];

        if (!this.streamId) {
            throw new Error("Creating a delta before the stream is created");
        }

        return { end, parts, start, streamId: this.streamId };
    }

    public async finish() {
        if (!this.streamId) {
            return;
        }

        await this.#ongoingWrite;
        await this.#sendDelta();
        await this.context.runMutation(internal.agent.streams.finish, {
            streamId: this.streamId as Id<"streamingMessages">,
        });
    }

    public async fail(reason: string) {
        if (this.abortController.signal.aborted) {
            return;
        }

        this.abortController.abort();

        if (!this.streamId) {
            return;
        }

        await this.#ongoingWrite;
        await this.context.runMutation(internal.agent.streams.abort, {
            reason,
            streamId: this.streamId as Id<"streamingMessages">,
        });
    }
}

/**
 * Compressing parts when streaming to save bandwidth in deltas.
 */

export function compressUIMessageChunks(parts: UIMessageChunk[]): UIMessageChunk[] {
    const compressed: UIMessageChunk[] = [];

    for (const part of parts) {
        const last = compressed.at(-1);

        if (part.type === "text-delta" || part.type === "reasoning-delta") {
            if (last?.type === part.type && part.id === last.id) {
                last.delta += part.delta;
            } else {
                compressed.push(part);
            }
        } else {
            compressed.push(part);
        }
    }

    return compressed;
}

export function compressTextStreamParts(parts: TextStreamPart<ToolSet>[]): TextStreamPart<ToolSet>[] {
    const compressed: TextStreamPart<ToolSet>[] = [];

    for (const part of parts) {
        const last = compressed.at(-1);

        if (part.type === "text-delta" || part.type === "reasoning-delta") {
            if (last?.type === part.type && part.id === last.id) {
                last.text += part.text;
            } else {
                compressed.push(part);
            }
        } else {
            if (part.type === "file") {
                compressed.push({
                    file: {
                        ...part.file,
                        uint8Array: undefined as unknown as Uint8Array,
                    },
                    type: "file",
                });
            }

            compressed.push(part);
        }
    }

    return compressed;
}
