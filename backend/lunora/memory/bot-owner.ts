import type { Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/** Bound parameters one D1 statement takes is capped at 100; a batch of bot ids leaves room for nothing else. */
const BOT_OWNER_BATCH = 50;

/**
 * The `botOwners` row of each bot in `botIds` that has one: its owner and whether the owner deleted it. One `in` read per
 * batch of ids, so a list of many shared bots reads `botOwners` in ceil(n / 50) queries instead of n. A `.global()` read
 * on the primary: the owner's rows are on no shard the caller can name, and a replica may lag a fresh row.
 */
export const botOwnerRows = async (ctx: Pick<QueryCtx, "db">, botIds: ReadonlyArray<string>): Promise<Map<string, { deleted: boolean; ownerId: string }>> => {
    const rows = new Map<string, { deleted: boolean; ownerId: string }>();

    for (let start = 0; start < botIds.length; start += BOT_OWNER_BATCH) {
        const batch = botIds.slice(start, start + BOT_OWNER_BATCH) as Id<"bots">[];
        const { page } = await ctx.db.botOwners.findMany({ consistency: "primary", where: { botId: { in: batch } } });

        for (const owner of page) {
            // A live row outranks a tombstone of the same bot: a restore cut short leaves both (`bots/owner.ts`).
            if (rows.get(owner.botId as string)?.deleted !== false) {
                rows.set(owner.botId as string, { deleted: owner.deletedAt !== undefined, ownerId: owner.ownerId as string });
            }
        }
    }

    return rows;
};
