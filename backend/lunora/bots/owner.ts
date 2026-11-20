import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { currentUserShard } from "../lib/shard-context";

/** Bound parameters one D1 statement takes is capped at 100; a batch of bot ids leaves room for nothing else. */
const BOT_OWNER_BATCH = 50;

/**
 * How long a deleted bot's owner record is kept. Past it the record goes (`pruneBotOwnerTombstonesOf`), and a memory still
 * naming the bot is labelled "Learned by a bot" instead of "Learned by a deleted bot", so the global table does not grow
 * with every bot a person ever deleted.
 */
export const BOT_OWNER_TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Tombstones removed per sweep run; the next daily run takes the rest. */
const TOMBSTONE_PRUNE_PAGE = 100;

/**
 * Tombstones a deleted bot's `botOwners` row, which stays for memories another person learned from the bot. Primary: a
 * replica that lags the bot's creation would miss the row, write no tombstone and leave the bot labelled as live.
 */
export const markBotOwnerDeleted = async (ctx: Pick<MutationCtx, "db">, botId: Id<"bots">, now: number): Promise<void> => {
    // Every row of the bot: a restore cut short leaves two (`restoreLiveBotOwnersOf`).
    const { page } = await ctx.db.botOwners.findMany({ consistency: "primary", where: { botId } });

    for (const owner of page) {
        await ctx.db.patch("botOwners", owner._id, { deletedAt: now });
    }
};

/**
 * Clears the tombstone of each of `userId`'s bots that still exists. `deleteBot` writes the tombstone to the global store
 * and deletes the bot on the owner's shard, and the two do not commit together, so a delete that failed after its
 * tombstone was written would otherwise leave a live bot labelled as deleted in other people's lists. Run on that shard.
 */
export const restoreLiveBotOwnersOf = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const bots = await ctx.db
        .query("bots")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        // `MAX_BOTS_PER_USER` (`functions.ts`, which imports this file): a user has no more bots than that.
        .take(100);
    const botIds = bots.map((bot) => bot._id);

    for (let start = 0; start < botIds.length; start += BOT_OWNER_BATCH) {
        const { page } = await ctx.db.botOwners.findMany({ consistency: "primary", where: { botId: { in: botIds.slice(start, start + BOT_OWNER_BATCH) } } });

        const live = new Set(page.filter((row) => row.deletedAt === undefined).map((row) => row.botId as string));

        // A row cannot drop a field by patch, so a live row is written first and the tombstoned one deleted after: D1 writes
        // do not roll back together, and a failure between the two leaves both (readers take the live one), never neither.
        for (const owner of page) {
            if (owner.deletedAt === undefined) {
                continue;
            }

            if (!live.has(owner.botId as string)) {
                await ctx.db.insert("botOwners", { botId: owner.botId, createdAt: owner.createdAt, ownerId: owner.ownerId });
                live.add(owner.botId as string);
            }

            await ctx.db.delete("botOwners", owner._id);
        }
    }
};

/** Deletes `userId`'s bot owner records whose bot was deleted more than {@link BOT_OWNER_TOMBSTONE_TTL_MS} before `now`. */
export const pruneBotOwnerTombstonesOf = async (ctx: Pick<MutationCtx, "db">, userId: string, now: number): Promise<void> => {
    const { page } = await ctx.db.botOwners.findMany({
        consistency: "primary",
        limit: TOMBSTONE_PRUNE_PAGE,
        where: { deletedAt: { lt: now - BOT_OWNER_TOMBSTONE_TTL_MS }, ownerId: userId },
    });

    for (const owner of page) {
        await ctx.db.delete("botOwners", owner._id);
    }
};

/**
 * Housekeeping sweep (`shardSweeps()`) for the shard's own user: {@link restoreLiveBotOwnersOf}, then
 * {@link pruneBotOwnerTombstonesOf}.
 */
export const restoreLiveBotOwners = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const userId = currentUserShard();

        if (userId !== undefined) {
            await restoreLiveBotOwnersOf(ctx, userId);
            await pruneBotOwnerTombstonesOf(ctx, userId, ctx.now);
        }

        return null;
    });
