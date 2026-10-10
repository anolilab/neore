import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../../_generated/internal";
import type { Id } from "../../../_generated/dataModel";
import { shardContext } from "../../../lib/http-shard";
import { verifySignedRequest } from "../../../lib/sign-request";
import { threadShardFor } from "../../../lib/thread-shard";
import { streamLogger } from "../../../lib/logger";
import type { StreamStatus } from "./schema";

/**
 * How often a held request re-reads the stream.
 *
 * Every read is a `runQuery` from this Worker to the stream's shard Durable
 * Object — a SUBREQUEST, and a billed DO request. Workers cap subrequests per
 * invocation (50 on the Free plan), so the hold is bounded by a read COUNT, not
 * by time alone: {@link CHUNKS_MAX_READS} reads, one every tick. The request's
 * other subrequest is the thread-shard lookup (`threadShardFor`, cached), so an
 * invocation makes at most `CHUNKS_MAX_READS + 1` — well under 50.
 *
 * DO requests per stream stay below the interval polling this replaced (100ms
 * polls of TWO queries each, so up to 20/s): at most one read per tick, 10/s.
 */
export const CHUNKS_WAIT_TICK_MS = 100;

/** Reads per `/chat/chunks` invocation, the first included. */
export const CHUNKS_MAX_READS = 20;

/** The longest one request is held: the last read comes this long after the first. */
export const CHUNKS_MAX_WAIT_MS = (CHUNKS_MAX_READS - 1) * CHUNKS_WAIT_TICK_MS;

const TERMINAL_STATUSES: ReadonlySet<StreamStatus> = new Set(["done", "error", "timeout"]);

export interface ChunkRead {
    chunks: { reasoning?: string; speaker?: { name: string; skillId: string }; text: string }[];
    status: StreamStatus;
    totalChunks: number;
}

/**
 * Read the stream until it has something new — a chunk past the caller's index,
 * or a terminal status — or `waitMs` has passed or {@link CHUNKS_MAX_READS}
 * reads were made, then answer with the last read.
 * `waitMs: 0` is one read, which is what a caller that sends no `waitMs` (an
 * older gateway) gets. Exported for the test.
 */
export const readChunksWhenReady = async (
    read: () => Promise<ChunkRead>,
    waitMs: number,
    {
        now = Date.now,
        sleep = async (ms: number) =>
            await new Promise<void>((resolve) => {
                setTimeout(resolve, ms);
            }),
    } = {},
): Promise<ChunkRead> => {
    const deadline = now() + waitMs;

    for (let reads = 1; ; reads += 1) {
        const result = await read();

        if (result.chunks.length > 0 || TERMINAL_STATUSES.has(result.status) || reads >= CHUNKS_MAX_READS || now() + CHUNKS_WAIT_TICK_MS > deadline) {
            return result;
        }

        await sleep(CHUNKS_WAIT_TICK_MS);
    }
};

/** `waitMs` from the body, clamped to what this endpoint will hold. Anything unusable is 0: answer at once. */
export const toChunkWaitMs = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(value, CHUNKS_MAX_WAIT_MS) : 0;

/**
 * HTTP action handler for POST /chat/chunks
 * Gateway polls this to get new chunks from a stream.
 *
 * With `waitMs` the request is a long-poll: it is answered as soon as a chunk
 * past `afterIndex` exists or the stream ends, and after `waitMs` at the latest.
 * The reply then carries `longPoll: true`, telling the gateway it may ask again
 * at once instead of sleeping between polls.
 */
export const getChunksHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    // Verify HMAC authentication
    const signingSecret = process.env.LLM_GATEWAY_SIGNING_SECRET!;
    const valid = await verifySignedRequest(request, signingSecret);

    if (!valid) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Parse request body
    // `threadId`/`userId` come from the stream token the gateway verified; this
    // request is signed, so they are as trustworthy as that token.
    let body: { afterIndex: number; streamId: string; threadId?: string; userId?: string; waitMs?: unknown };

    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { afterIndex, streamId, threadId, userId } = body;

    if (!streamId || afterIndex == null) {
        return Response.json({ error: "Missing required parameters: streamId, afterIndex" }, { status: 400 });
    }

    // The stream lives on its thread's shard (docs/plans/per-user-sharding.md).
    // A poll with no user (an older gateway) can only look on `__root__`.
    if (userId) {
        context = shardContext(context, await threadShardFor(context, userId, threadId));
    }

    const waitMs = toChunkWaitMs(body.waitMs);

    try {
        // Chunks and status in ONE query (see `getChunksAfter`), so a `done`
        // answer always carries the final chunk.
        const result = await readChunksWhenReady(
            async () =>
                await context.runQuery(internal.chat.streaming.persistent.library.getChunksAfter, {
                    afterIndex,
                    streamId: streamId as Id<"persistentStreams">,
                }),
            waitMs,
        );

        return Response.json({
            chunks: result.chunks,
            ...(waitMs > 0 && { longPoll: true }),
            status: result.status,
            totalChunks: result.totalChunks,
        });
    } catch (error) {
        streamLogger.error("[ChunkAPI] Error fetching chunks:", error);

        return Response.json({ error: "Failed to fetch chunks" }, { status: 500 });
    }
};
