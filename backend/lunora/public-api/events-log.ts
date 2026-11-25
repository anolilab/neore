/**
 * The write surface of the `mcpEvents` log. `public-api/module.ts` owns the table, so the chat module (the approval path and
 * the run end) writes it only through these plain functions, inside its own mutation: the event and the row it describes
 * commit together, or neither does.
 *
 * One row per upstream event, keyed by `(userId, eventId)`. A recorder that runs twice for the same event writes once, so a
 * redelivered job cannot double a run's event.
 */
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { noteRetentionWake } from "../lib/shard-housekeeping";
import { runAfterOnShard } from "../lib/shard-scheduler";

/** What a write to the log takes: its db, its clock, and the scheduler that carries the expiry wake and its retry. */
type LogWriteCtx = Pick<MutationCtx, "db" | "now" | "scheduler">;

/** How long a poll can look back: a cursor older than this reads as truncated. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecordEventInput {
    data: Record<string, unknown>;
    /** Stable per upstream event: the same event recorded twice is one row. */
    eventId: string;
    name: string;
    /** When the event occurred. */
    timestamp: number;
    /** The owner whose log the event goes to (the thread owner, never a collaborator). */
    userId: string;
}

/**
 * The most bytes a recorded payload may hold. A larger one is kept as its thread and an `omitted` mark, so the event still reaches
 * a poll and a poll's answer stays within its size budget (`events-poll.ts`).
 */
export const MAX_EVENT_PAYLOAD_BYTES = 16 * 1024;

const omittedPayload = (thread: string | undefined): string => JSON.stringify({ omitted: true, ...(thread !== undefined && { threadId: thread }) });

/** The stored payload, bounded: JSON text within the limit, or the omitted mark for one past it. */
const boundedPayload = (json: string, thread: string | undefined): string =>
    new TextEncoder().encode(json).byteLength <= MAX_EVENT_PAYLOAD_BYTES ? json : omittedPayload(thread);

/** Events a thread's removal deletes per call; the caller runs again while any are left. */
const THREAD_EVENT_BATCH = 200;

/** The thread an event's payload names, or `undefined` for an event that names none. */
const threadOf = (data: Record<string, unknown>): string | undefined => (typeof data["threadId"] === "string" ? data["threadId"] : undefined);

/** The thread a stored payload (JSON text) names: a payload that is not a JSON object names none. */
const storedThreadOf = (data: string): string | undefined => {
    let parsed: unknown;

    try {
        parsed = JSON.parse(data);
    } catch {
        return undefined;
    }

    return typeof parsed === "object" && parsed !== null ? threadOf(parsed as Record<string, unknown>) : undefined;
};

/** How long after a failed wake write its retry runs; each further failure doubles the wait, up to `EVENT_WAKE_MAX_ATTEMPTS`. */
export const EVENT_WAKE_RETRY_MS = 60 * 1000;
export const EVENT_WAKE_MAX_ATTEMPTS = 10;

/**
 * Wakes `userId`'s shard for an event's expiry. The census write is best-effort, so a run's write never fails on it. A write that
 * failed is retried by a job scheduled here, in the same transaction as the event: the event and its retry commit together, so a
 * shard is never left holding an expiring event with no wake for it.
 */
const wakeForExpiry = async (ctx: LogWriteCtx, userId: string, dueAt: number): Promise<void> => {
    if (await noteRetentionWake(ctx, dueAt)) {
        return;
    }

    // Always scheduled: the retry is what keeps a failed census write from leaving an expiring event with no wake.
    await runAfterOnShard(ctx.scheduler, EVENT_WAKE_RETRY_MS, internal.public_api.events.retryEventWake, { attempt: 1, dueAt, userId }, userId);
};

/**
 * Appends the event to `userId`'s log and returns `true`, or returns `false` when that event is already there.
 *
 * `seq` is one past the user's watermark (`mcpEventWatermarks`), which is advanced in the same mutation. Writes to a shard are
 * serialized, so no two appends can take the same number. The watermark outlives the rows, so retention can delete every
 * event without the sequence restarting.
 */
export const recordMcpEvent = async (ctx: LogWriteCtx, input: RecordEventInput): Promise<boolean> => {
    const existing = await ctx.db.mcpEvents.findFirst({ consistency: "primary", where: { eventId: input.eventId, userId: input.userId } });

    if (existing) {
        return false;
    }

    // Read from the primary: a sequence number another write already took must not be reissued from a lagging replica.
    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ consistency: "primary", where: { userId: input.userId } });
    const seq = (watermark?.seq ?? 0) + 1;
    const threadId = threadOf(input.data);

    await ctx.db.insert("mcpEvents", {
        createdAt: ctx.now,
        data: boundedPayload(JSON.stringify(input.data), threadOf(input.data)),
        eventId: input.eventId,
        name: input.name,
        seq,
        ...(threadId !== undefined && { threadId }),
        timestamp: input.timestamp,
        userId: input.userId,
    });
    await setWatermark(ctx, input.userId, watermark?._id, seq);
    // The event expires a window from now: the shard is woken then, so the sweep finds it even with no other retained rows.
    await wakeForExpiry(ctx, input.userId, ctx.now + RETENTION_MS);

    return true;
};

const setWatermark = async (ctx: Pick<MutationCtx, "db">, userId: string, rowId: string | undefined, seq: number): Promise<void> => {
    if (rowId === undefined) {
        await ctx.db.insert("mcpEventWatermarks", { seq, userId });
    } else {
        await ctx.db.patch("mcpEventWatermarks", rowId as never, { seq });
    }
};

/**
 * Deletes up to a batch of `userId`'s events for `threadId`, and returns `true` once none are left. A deleted thread's events go
 * with it: the poll hides a locked thread's events only while the thread exists, so they must not outlive it.
 */
export const deleteMcpEventsOfThread = async (ctx: Pick<MutationCtx, "db">, userId: string, threadId: string): Promise<boolean> => {
    // One row past the batch says whether more follow: a batch that ends the thread's events is not reported as more.
    const { page } = await ctx.db.mcpEvents.findMany({ limit: THREAD_EVENT_BATCH + 1, where: { threadId, userId } });

    for (const row of page.slice(0, THREAD_EVENT_BATCH)) {
        await ctx.db.delete("mcpEvents", row._id);
    }

    return page.length <= THREAD_EVENT_BATCH;
};

/**
 * Appends a merged guest's events to `to`'s log (`lib/account-merge.ts`). A guest's `seq` means nothing in the new account's log,
 * so each row takes the next number after `to`'s watermark, in guest order. An event `to` already has (a redelivered page) is
 * skipped, so a page imported twice writes once. Returns the number appended.
 *
 * Each row's `createdAt` is the copy's own time, so it rises with `seq`: retention deletes by `createdAt`, and a guest's older
 * `createdAt` would expire a merged row before the older rows below it, leaving a hole the poll never reports. The event's
 * `timestamp` keeps the time it happened.
 */
export const copyMergedMcpEvents = async (ctx: LogWriteCtx, rows: Record<string, unknown>[], to: string): Promise<number> => {
    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ consistency: "primary", where: { userId: to } });
    let seq = watermark?.seq ?? 0;
    let appended = 0;

    const ordered = rows.toSorted((a, b) => (a["seq"] as number) - (b["seq"] as number));

    for (const row of ordered) {
        // A row a window old is expired already: copying it would restamp it now and make it readable again for a whole window. It is
        // not copied; the merge still confirms it, so the clear removes it from the guest's shard.
        if ((row["createdAt"] as number) < ctx.now - RETENTION_MS) {
            continue;
        }

        const eventId = row["eventId"] as string;

        if (await ctx.db.mcpEvents.findFirst({ consistency: "primary", where: { eventId, userId: to } })) {
            continue;
        }

        seq += 1;
        appended += 1;

        const threadId = storedThreadOf(row["data"] as string);

        await ctx.db.insert("mcpEvents", {
            createdAt: ctx.now,
            data: boundedPayload(row["data"] as string, storedThreadOf(row["data"] as string)),
            eventId,
            name: row["name"] as string,
            seq,
            ...(threadId !== undefined && { threadId }),
            timestamp: row["timestamp"] as number,
            userId: to,
        });
    }

    if (appended > 0) {
        await setWatermark(ctx, to, watermark?._id, seq);
        // The copied rows expire a window from the copy, as a recorded event does (see `recordMcpEvent`).
        await wakeForExpiry(ctx, to, ctx.now + RETENTION_MS);
    }

    return appended;
};
