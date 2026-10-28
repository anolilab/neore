/**
 * The writes a host-run turn makes on `persistentStreams` / `persistentChunks` (`acp/`). A host stream is an
 * ordinary stream row, so every reader that finds a cloud stream finds this one; what differs is who writes it.
 * The host posts its events, and each event takes the `seq` the host gave it instead of the next free one
 * (`addChunk` stamps its own). The stored `seq` is the claim that makes a redelivered post a no-op.
 */
import { HOST_STREAM_IDLE_MS } from "../../../acp/lib/constants";
import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { patchThread } from "../../../agent/table-writes";
import { patchRow, withoutUndefined } from "../../../lib/patch";
import { noteShardDue } from "../../../lib/shard-housekeeping";

type HostState = NonNullable<Doc<"persistentStreams">["hostState"]>;
type EndReason = NonNullable<Doc<"persistentStreams">["hostEndReason"]>;
type Stream = Doc<"persistentStreams">;

const HOST_STATE_RANK: Record<HostState, number> = { accepted: 0, ended: 3, received: 1, running: 2 };

/** Forward only, skips allowed: a local prompt goes from nothing straight to `received` or `running`. */
export const isForwardHostState = (current: HostState | undefined, next: HostState): boolean =>
    HOST_STATE_RANK[next] > (current === undefined ? -1 : HOST_STATE_RANK[current]);

export const isLiveStream = (stream: Pick<Stream, "status">): boolean => stream.status === "pending" || stream.status === "streaming";

/**
 * A new host stream. `messageId` is the PROMPT's row, as for a cloud turn; `regenerate` makes the reply a
 * sibling of the earlier one. The reaper window starts now.
 */
export const createHostStream = async (
    ctx: Pick<MutationCtx, "db">,
    stream: { hostState: HostState; messageId: string; regenerate?: boolean; threadId: Id<"threads">; turnId: string; userId: string },
    now: number,
): Promise<Id<"persistentStreams">> => {
    const { hostState, messageId, regenerate, threadId, turnId, userId } = stream;
    const expiresAt = now + HOST_STREAM_IDLE_MS;
    const streamId = await ctx.db.insert("persistentStreams", {
        expiresAt,
        hostState,
        hostTurnId: turnId,
        messageId,
        producer: "host",
        status: "pending",
        streamingConfig: { contentType: "text", model: "host" },
        threadId,
        userId,
        ...(regenerate && { hostRegenerate: true }),
    });

    await noteShardDue(ctx, expiresAt);
    await patchThread(ctx.db, threadId, { status: "running", updatedAt: now });

    return streamId;
};

/**
 * What one post changes on the stream row, in a single write: the first content moves `pending` to `streaming`,
 * `hostState` moves forward, the reaper window moves on (rarely: see {@link bumpedExpiry}), and the list of
 * permission requests the agent is waiting on follows the posted events. The caller writes only when something
 * changed, since this row is read by a live query.
 */
export const updateHostStream = async (
    ctx: Pick<MutationCtx, "db">,
    stream: Stream,
    changes: { expiresAt?: number; hostState?: HostState; pending: string[]; streaming: boolean },
): Promise<void> => {
    await patchRow(ctx.db, stream, {
        ...withoutUndefined({
            expiresAt: changes.expiresAt,
            hostState: changes.hostState,
            status: changes.streaming && stream.status === "pending" ? "streaming" : undefined,
        }),
        // `patchRow` removes a key set to `undefined`: only the permission list is ever meant to go.
        ...(changes.pending.length > 0
            ? { hostPendingPermissions: changes.pending }
            : stream.hostPendingPermissions !== undefined && { hostPendingPermissions: undefined }),
    });
};

/** Moves a live host stream's reaper window on from `now`: it is waiting on a person, not on its host. */
export const extendHostStream = async (ctx: Pick<MutationCtx, "db">, stream: Stream, now: number): Promise<void> => {
    await ctx.db.patch(stream._id, { expiresAt: now + HOST_STREAM_IDLE_MS });
};

/** The `seq` the next event must carry: one past the last chunk, read off `by_streamId_seq`. */
export const nextHostSeq = async (ctx: Pick<MutationCtx, "db">, streamId: Id<"persistentStreams">): Promise<number> => {
    const last = await ctx.db.persistentChunks.findFirst({ orderBy: [{ seq: "desc" }], where: { streamId } });

    return last ? last.seq + 1 : 0;
};

export const appendHostChunk = async (
    ctx: Pick<MutationCtx, "db">,
    streamId: Id<"persistentStreams">,
    seq: number,
    fields: Pick<Doc<"persistentChunks">, "event" | "reasoning" | "text">,
): Promise<void> => {
    await ctx.db.insert("persistentChunks", {
        seq,
        streamId,
        text: fields.text,
        ...(fields.reasoning !== undefined && { reasoning: fields.reasoning }),
        ...(fields.event !== undefined && { event: fields.event }),
    });
};

/**
 * Moves the reaper window forward, but only once half of it is gone: the stream row is read by a live query
 * (`getActiveStreamForThread`), so a write on every post would re-run it for every viewer four times a second.
 */
export const bumpedExpiry = (stream: Pick<Stream, "expiresAt">, now: number): number | undefined =>
    stream.expiresAt - now < HOST_STREAM_IDLE_MS / 2 ? now + HOST_STREAM_IDLE_MS : undefined;

/** Hands the thread back from `running` unless another live stream or an edit on it still holds it. */
export const releaseThread = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, now: number): Promise<void> => {
    const [thread, live] = await Promise.all([
        ctx.db.threads.findFirst({ where: { _id: threadId } }),
        ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId } }),
    ]);

    if (thread?.status === "running" && !live) {
        await patchThread(ctx.db, threadId, { status: "active", updatedAt: now });
    }
};

/**
 * Ends a host stream in one write: its status, `hostState: ended` and why. Every terminal path goes through
 * here (the host's `turn_end`, the reaper, a revoked device, Stop), so none can leave a stream that reads as
 * live to one client and ended to another. Returns false when the stream was already over.
 */
export const endHostStream = async (
    ctx: Pick<MutationCtx, "db">,
    stream: Stream,
    end: { reason: EndReason; status: "done" | "error" | "timeout" },
    now: number,
): Promise<boolean> => {
    if (!isLiveStream(stream)) {
        return false;
    }

    await patchRow(ctx.db, stream, {
        hostEndReason: end.reason,
        hostState: "ended",
        status: end.status,
        ...(stream.hostPendingPermissions !== undefined && { hostPendingPermissions: undefined }),
    });
    await releaseThread(ctx, stream.threadId as Id<"threads">, now);

    return true;
};
