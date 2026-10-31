import type { HttpActionCtx } from "lunorash/server";

import { internal } from "../../../_generated/internal";
import type { Id } from "../../../_generated/dataModel";
import { inSystemShard, systemRunners } from "../../../lib/http-shard";
import { verifySignedRequest } from "../../../lib/sign-request";
import { threadShardFor } from "../../../lib/thread-shard";
import { streamLogger } from "../../../lib/logger";
import { THREAD_LOCKED_CODE } from "../../../lib/thread-lock";
import { MAX_LENGTH } from "../../../lib/validators";
import type { ToolProgressChunk } from "../../lib/mcp-progress";
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
    chunks: {
        reasoning?: string;
        restart?: boolean;
        speaker?: { name: string; skillId: string };
        text: string;
        toolProgress?: ToolProgressChunk;
    }[];
    locked: boolean;
    status: StreamStatus;
    totalChunks: number;
}

/**
 * Read the stream until it has something new — a chunk past the caller's index,
 * a terminal status, or a lock — or `waitMs` has passed or {@link CHUNKS_MAX_READS}
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

        if (
            result.locked ||
            result.chunks.length > 0 ||
            TERMINAL_STATUSES.has(result.status) ||
            reads >= CHUNKS_MAX_READS ||
            now() + CHUNKS_WAIT_TICK_MS > deadline
        ) {
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
    // `threadId`/`userId` come from the stream token the gateway verified, and the
    // body is covered by the HMAC above, so they are as trustworthy as that token.
    let body: { afterIndex: number; streamId: string; threadId?: unknown; userId?: unknown; waitMs?: unknown };

    try {
        body = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { afterIndex, streamId, threadId, userId } = body;

    if (!streamId || afterIndex == null) {
        return Response.json({ error: "Missing required parameters: streamId, afterIndex" }, { status: 400 });
    }

    const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_LENGTH.id;

    if ((userId !== undefined && !isId(userId)) || (threadId !== undefined && !isId(threadId))) {
        return Response.json({ error: "Invalid userId or threadId" }, { status: 400 });
    }

    const waitMs = toChunkWaitMs(body.waitMs);

    // A poll with no user (an older gateway) can only look on `__root__`.
    if (userId === undefined) {
        return await serveChunks(context, { afterIndex, streamId, waitMs });
    }

    // The request is verified, so it may cross into a shard as the system (the
    // runtime would refuse a user-less request). The stream lives on its thread's
    // shard; the read below also checks the stream is this user's and this thread's.
    const shardKey = await threadShardFor(context, userId, threadId, systemRunners(userId));

    return await inSystemShard(context, shardKey, async (shardCtx) => await serveChunks(shardCtx, { afterIndex, streamId, threadId, userId, waitMs }));
};

const serveChunks = async (
    context: HttpActionCtx,
    { afterIndex, streamId, threadId, userId, waitMs }: { afterIndex: number; streamId: string; threadId?: string; userId?: string; waitMs: number },
): Promise<Response> => {
    try {
        // Chunks, status and the lock in ONE query (see `getChunksAfter`), so a
        // `done` answer always carries the final chunk. This poll carries no
        // passcode proof: a thread locked after the stream was created is refused
        // at once, and nothing may read on from it.
        // The lock is checked on the first read and whenever a read returns chunks, so an
        // idle wait reads no thread. A poll that ends empty is checked once more.
        // `userId`/`threadId` make the query answer "no such stream" for another user's stream.
        const readChunks = async (checkLock: boolean) =>
            await context.runQuery(internal.chat.streaming.persistent.library.getChunksAfter, {
                afterIndex,
                checkLock,
                streamId: streamId as Id<"persistentStreams">,
                ...(threadId !== undefined && { threadId }),
                ...(userId !== undefined && { userId }),
            });

        let reads = 0;
        let result = await readChunksWhenReady(async () => {
            reads += 1;

            return await readChunks(reads === 1);
        }, waitMs);

        if (!result.locked && result.chunks.length === 0 && reads > 1) {
            result = await readChunks(true);
        }

        if (result.locked) {
            return Response.json({ code: THREAD_LOCKED_CODE, error: "This chat is locked." }, { status: 403 });
        }

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
