/**
 * The write surface of the `mcpEvents` log. `public-api/module.ts` owns the table, so the chat module (the approval path and
 * the run end) writes it only through these plain functions, inside its own mutation: the event and the row it describes
 * commit together, or neither does.
 *
 * One row per upstream event, keyed by `(userId, eventId)`. A recorder that runs twice for the same event writes once, so a
 * redelivered job cannot double a run's event.
 */
import type { MutationCtx } from "../_generated/server";

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
 * `seq` is one past the user's highest, read in the same mutation. Writes to a shard are serialized, so no two appends can
 * take the same number. Retention never deletes the highest row (`pruneMcpEvents`), so the sequence never restarts.
 */
export const recordMcpEvent = async (ctx: Pick<MutationCtx, "db" | "now">, input: RecordEventInput): Promise<boolean> => {
    const existing = await ctx.db.mcpEvents.findFirst({ where: { eventId: input.eventId, userId: input.userId } });

    if (existing) {
        return false;
    }

    const last = await ctx.db.mcpEvents.findFirst({ orderBy: [{ seq: "desc" }], where: { userId: input.userId } });

    await ctx.db.insert("mcpEvents", {
        createdAt: ctx.now,
        data: JSON.stringify(input.data),
        eventId: input.eventId,
        name: input.name,
        seq: (last?.seq ?? 0) + 1,
        timestamp: input.timestamp,
        userId: input.userId,
    });

    return true;
};
