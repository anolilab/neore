/**
 * The write surface of the `mcpEvents` log. `public-api/module.ts` owns the table, so the chat module (the approval path and
 * the run end) writes it only through these plain functions, inside its own mutation: the event and the row it describes
 * commit together, or neither does.
 *
 * One row per upstream event, keyed by `(userId, eventId)`. A recorder that runs twice for the same event writes once, so a
 * redelivered job cannot double a run's event.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { noteRetentionWake } from "../lib/shard-housekeeping";
import { RUN_COMPLETED_EVENT, RUN_FAILED_EVENT } from "./events-catalog";

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
 * Appends the event to `userId`'s log and returns `true`, or returns `false` when that event is already there.
 *
 * `seq` is one past the user's watermark (`mcpEventWatermarks`), which is advanced in the same mutation. Writes to a shard are
 * serialized, so no two appends can take the same number. The watermark outlives the rows, so retention can delete every
 * event without the sequence restarting.
 */
export const recordMcpEvent = async (ctx: Pick<MutationCtx, "db" | "now">, input: RecordEventInput): Promise<boolean> => {
    const existing = await ctx.db.mcpEvents.findFirst({ where: { eventId: input.eventId, userId: input.userId } });

    if (existing) {
        return false;
    }

    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId: input.userId } });
    const seq = (watermark?.seq ?? 0) + 1;

    await ctx.db.insert("mcpEvents", {
        createdAt: ctx.now,
        data: JSON.stringify(input.data),
        eventId: input.eventId,
        name: input.name,
        seq,
        timestamp: input.timestamp,
        userId: input.userId,
    });
    await setWatermark(ctx, input.userId, watermark?._id, seq);
    // The event expires a window from now: the shard is woken then, so the sweep finds it even with no other retained rows.
    await noteRetentionWake(ctx, ctx.now + RETENTION_MS);

    return true;
};

/**
 * Records how a reply's run ended, for the thread's owner. Keyed by the stream, so one reply has one end event however often
 * the end is written: the final chunk, a live stream set to error, and a timed-out stream all go through here.
 *
 * A thread with no owner (its owner's account was removed) falls back to the run's starter, as the tool approval path does, so
 * the end still reaches a log. Nothing is recorded when neither is known.
 */
export const recordRunEnd = async (
    ctx: Pick<MutationCtx, "db" | "now">,
    input: { outcome: "succeeded" | "failed"; starterId?: string; streamId: string; threadId: string },
): Promise<void> => {
    const thread = await ctx.db.get("threads", input.threadId as Id<"threads">);

    // A thread row that is gone was deleted: its run's log is not reachable from this shard, so nothing is recorded here.
    if (!thread) {
        return;
    }

    const owner = thread.userId ?? input.starterId;

    if (owner === undefined) {
        return;
    }

    await recordMcpEvent(ctx, {
        data: { finishedAt: ctx.now, outcome: input.outcome, threadId: input.threadId },
        eventId: `run:${input.streamId}`,
        name: input.outcome === "succeeded" ? RUN_COMPLETED_EVENT : RUN_FAILED_EVENT,
        timestamp: ctx.now,
        userId: owner,
    });
};

const setWatermark = async (ctx: Pick<MutationCtx, "db">, userId: string, rowId: string | undefined, seq: number): Promise<void> => {
    if (rowId === undefined) {
        await ctx.db.insert("mcpEventWatermarks", { seq, userId });
    } else {
        await ctx.db.patch("mcpEventWatermarks", rowId as never, { seq });
    }
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
export const copyMergedMcpEvents = async (ctx: Pick<MutationCtx, "db" | "now">, rows: Record<string, unknown>[], to: string): Promise<number> => {
    const watermark = await ctx.db.mcpEventWatermarks.findFirst({ where: { userId: to } });
    let seq = watermark?.seq ?? 0;
    let appended = 0;

    const ordered = rows.toSorted((a, b) => (a["seq"] as number) - (b["seq"] as number));

    for (const row of ordered) {
        const eventId = row["eventId"] as string;

        if (await ctx.db.mcpEvents.findFirst({ where: { eventId, userId: to } })) {
            continue;
        }

        seq += 1;
        appended += 1;

        await ctx.db.insert("mcpEvents", {
            createdAt: ctx.now,
            data: row["data"] as string,
            eventId,
            name: row["name"] as string,
            seq,
            timestamp: row["timestamp"] as number,
            userId: to,
        });
    }

    if (appended > 0) {
        await setWatermark(ctx, to, watermark?._id, seq);
        // The copied rows expire a window from the copy, as a recorded event does (see `recordMcpEvent`).
        await noteRetentionWake(ctx, ctx.now + RETENTION_MS);
    }

    return appended;
};
