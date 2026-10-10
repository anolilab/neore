/**
 * Persistent Text Streaming Client
 *
 * Adapted from the persistent-text-streaming component to work with local
 * streaming implementation instead of external component.
 */
import { v } from "lunorash/server";

import { internal } from "../../../_generated/internal";
import type { Id } from "../../../_generated/dataModel";
import type { StreamStatus } from "./schema";

/**
 * Was `string & { __isStreamId: true }` — a nominal brand over an opaque id, back
 * when the api handle was `any` and nothing better was available. The generated
 * `Id<"persistentStreams">` is already nominal, so aliasing it keeps the name
 * meaningful and removes every cast between the two.
 */
export type StreamId = Id<"persistentStreams">;
export const StreamIdValidator = v.string();
export type StreamBody = {
    reasoning: string;
    speaker?: { name: string; skillId: string };
    status: StreamStatus;
    text: string;
};

export type StreamChunk = string | { reasoning?: string; text: string };
export type ChunkAppender = (chunk: StreamChunk) => Promise<void>;
export type StreamWriter<A extends RunMutationContext> = (context: A, request: Request, streamId: StreamId, chunkAppender: ChunkAppender) => Promise<void>;

// TODO -- make more flexible. # of bytes, etc?
const hasDelimeter = (text: string) => text.includes(".") || text.includes("!") || text.includes("?");

// TODO -- some sort of wrapper with easy ergonomics for working with LLMs?
export class PersistentTextStreaming {
    /**
     * The api handle used to be injected as `any`, which erased the return type of
     * every call through it. Lunora's flat namespace puts all seven functions in
     * one module, so the class addresses them directly and the results are typed.
     * The constructor argument is kept and ignored so the one call site is
     * unchanged.
     */
    private readonly api = internal.chat.streaming.persistent.library;

    constructor(
        _api?: unknown,
        public options?: unknown,
    ) {}

    /**
     * Create a new stream. This will return a stream ID that can be used
     * in an HTTP action to stream data back out to the client while also
     * permanently persisting the final stream in the database.
     * @param ctx A context capable of running mutations.
     * @param args Stream creation arguments (messageId, userId, threadId, streamingConfig)
     * @returns The ID of the new stream.
     */
    async createStream(
        ctx: RunMutationContext,
        args: {
            messageId: string;
            streamingConfig: {
                contentType: string;
                customSystemPrompt?: string;
                enabledFeatures?: string[];
                imageSize?: string;
                model: string;
                reasoningEffort?: number;
                searchMode?: string;
                statelessMode?: boolean;
            };
            threadId: string;
            userId: string;
        },
    ): Promise<StreamId> {
        const id = await ctx.runMutation(this.api.createStream, args);

        return id as StreamId;
    }

    /**
     * Get the body of a stream. This will return the full text, reasoning,
     * and status of the stream.
     * @param ctx A context capable of running queries.
     * @param streamId The ID of the stream to get the body of.
     * @returns The body of the stream including text, reasoning, and status.
     */
    async getStreamBody(ctx: RunQueryContext, streamId: StreamId): Promise<StreamBody> {
        const { reasoning, speaker, status, text } = await ctx.runQuery(this.api.getStreamText, { streamId });

        return {
            reasoning: reasoning ?? "",
            ...(speaker && { speaker }),
            status: status as StreamStatus,
            text,
        };
    }

    /**
     * Inside an HTTP action, this will stream data back to the client while
     * also persisting the final stream in the database.
     * @param ctx A context capable of running actions.
     * @param request The HTTP request object.
     * to the stream with the given `StreamWriter`.
     * the headers of this response for CORS, etc.
     */
    async stream<A extends RunMutationContext>(ctx: A, request: Request, streamId: StreamId, streamWriter: StreamWriter<A>) {
        const streamState = await ctx.runQuery(this.api.getStreamStatus, {
            streamId,
        });

        if (streamState !== "pending") {
            console.log("Stream was already started");

            return new Response("", {
                status: 205,
            });
        }

        // Create a TransformStream to handle streaming data
        const { readable, writable } = new TransformStream();
        let writer = writable.getWriter() as WritableStreamDefaultWriter<Uint8Array> | null;
        const textEncoder = new TextEncoder();
        let pending = { reasoning: "", text: "" };

        const doStream = async () => {
            const chunkAppender: ChunkAppender = async (chunk) => {
                // Normalize input to object form
                const normalized = typeof chunk === "string" ? { text: chunk } : chunk;

                // write to this handler's response stream on every update
                if (writer) {
                    try {
                        await writer.write(textEncoder.encode(`${JSON.stringify(normalized)}\n`));
                    } catch (error) {
                        console.error("Error writing to stream", error);
                        console.error("Will skip writing to stream but continue database updates");
                        writer = null;
                    }
                }

                pending.text += normalized.text;
                pending.reasoning += normalized.reasoning || "";

                // write to the database periodically, like at the end of sentences
                if (hasDelimeter(normalized.text)) {
                    await this.addChunk(ctx, streamId, pending.text, pending.reasoning, false);
                    pending = { reasoning: "", text: "" };
                }
            };

            try {
                await streamWriter(ctx, request, streamId, chunkAppender);
            } catch (error) {
                await this.setStreamStatus(ctx, streamId, "error");

                if (writer) {
                    await writer.close();
                }

                throw error;
            }

            // Success? Flush any last updates
            await this.addChunk(ctx, streamId, pending.text, pending.reasoning, true);

            if (writer) {
                await writer.close();
            }
        };

        // Kick off the streaming, but don't await it.
        void doStream();

        // Send the readable back to the browser
        return new Response(readable);
    }

    // Internal helper -- add a chunk to the stream.
    private async addChunk(context: RunMutationContext, streamId: StreamId, text: string, reasoning: string, final: boolean) {
        await context.runMutation(this.api.addChunk, {
            final,
            reasoning: reasoning || undefined,
            streamId,
            text,
        });
    }

    // Internal helper -- set the status of a stream.
    private async setStreamStatus(context: RunMutationContext, streamId: StreamId, status: StreamStatus) {
        await context.runMutation(this.api.setStreamStatus, {
            status,
            streamId,
        });
    }
}

/* Type utils follow */

/**
 * These need "any context carrying the runner they call". A query context has no
 * `runQuery` and is only `{ db: unknown }`, so it cannot be indexed for that. Lunora's contexts do not all carry the same
 * ones — a `MutationCtx` has no `runAction` — so a structural constraint here
 * rejects legitimate callers; presence is guaranteed by the call site instead.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type RunQueryContext = Record<string, any>;
type RunMutationContext = Record<string, any>;

/**
 * Was a mapped type that re-tagged a component's public api as internal,
 * using a five-parameter `FunctionReference`. Lunora's takes three and has
 * no visibility parameter — `internal` is a separate generated object — so there
 * is nothing to re-tag. Removed with the `api: any` constructor argument it
 * existed to type.
 */
