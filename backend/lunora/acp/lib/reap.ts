/**
 * The host-stream reaper. A host stream with no post for {@link HOST_STREAM_IDLE_MS} is set to `timeout`, its
 * host is sent `acp_cancel`, and whatever arrives for it afterwards is dropped (the ingest answers `ended`).
 *
 * It runs on the shard tick (`lib/shard-housekeeping.ts#runShardTick`), which `createHostStream` and every
 * window bump arm through `noteShardDue`, so a silent stream is reaped within about a minute of its window
 * rather than waiting for the ten-minute housekeeping sweep (that sweep still reaps one through
 * `cleanupExpiredStreams`, as a backstop).
 */
import type { Doc, Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { endHostStream, extendHostStream } from "../../chat/streaming/persistent/host";
import { HOST_TURN_MAX_MS } from "./constants";
import { sendHostCancel } from "./finish";
import { sessionOfThread, touchSession } from "./sessions";

const REAP_BATCH = 100;

type Stream = Doc<"persistentStreams">;

/**
 * Times out one expired host stream, unless it is waiting on a permission answer: the person is the one holding
 * it up, not the host, so its window is moved on instead (which also keeps a pile of them from starving the batch).
 */
export const expireHostStream = async (ctx: MutationCtx, stream: Stream, now: number): Promise<void> => {
    const waitingOnPerson = (stream.hostPendingPermissions?.length ?? 0) > 0 && now - stream._creationTime < HOST_TURN_MAX_MS;

    if (waitingOnPerson) {
        await extendHostStream(ctx, stream, now);

        return;
    }

    if (!(await endHostStream(ctx, stream, { reason: "timeout", status: "timeout" }, now))) {
        return;
    }

    const session = await sessionOfThread(ctx, stream.threadId as Id<"threads">);

    if (session) {
        await touchSession(ctx, session, "idle", now);
    }

    await sendHostCancel(ctx, stream, now);
};

/** Reaps the expired host streams of this shard. Returns when the next live one expires, to re-arm the tick. */
export const reapExpiredHostStreams = async (ctx: MutationCtx, now: number): Promise<number | undefined> => {
    const { page: expired } = await ctx.db.persistentStreams.findMany({
        limit: REAP_BATCH,
        where: { expiresAt: { lt: now }, producer: "host", status: { in: ["pending", "streaming"] } },
    });

    for (const stream of expired) {
        await expireHostStream(ctx, stream, now);
    }

    const next = await ctx.db.persistentStreams.findFirst({
        orderBy: [{ expiresAt: "asc" }],
        where: { producer: "host", status: { in: ["pending", "streaming"] } },
    });

    return next?.expiresAt;
};
