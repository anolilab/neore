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

/** Live owner records read per sweep run to find one whose bot is gone; live records are at most a user's bots. */
const ORPHAN_PAGE = 200;

/**
 * D1 statements one sweep run may send (a Worker invocation may send 50 on the Free plan). A run that has nothing to
 * repair sends four; one with more work stops at the budget, and the next daily run takes the rest.
 */
export const BOT_OWNER_SWEEP_STATEMENTS = 40;

/** What is left of a run's statement budget; `spend` takes one and says whether there was one to take. */
interface StatementBudget {
    left: number;
}

const spend = (budget: StatementBudget): boolean => {
    if (budget.left <= 0) {
        return false;
    }

    budget.left -= 1;

    return true;
};

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
 * Brings `userId`'s owner records back in line with their bots, on their shard. A bot and its record are written to two
 * stores that do not commit together (`createBot`, `deleteBot`), so a write cut short leaves a bot labelled wrongly in
 * other people's lists: a live bot's tombstone is cleared, a live bot with no record gets one, and a live record whose
 * bot is gone is tombstoned.
 */
export const restoreLiveBotOwnersOf = async (ctx: Pick<MutationCtx, "db">, userId: string, now: number, budget: StatementBudget): Promise<void> => {
    const bots = await ctx.db
        .query("bots")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        // `MAX_BOTS_PER_USER` (`functions.ts`, which imports this file): a user has no more bots than that.
        .take(100);
    const botIds = bots.map((bot) => bot._id);

    for (let start = 0; start < botIds.length; start += BOT_OWNER_BATCH) {
        if (!spend(budget)) {
            return;
        }

        const { page } = await ctx.db.botOwners.findMany({ consistency: "primary", where: { botId: { in: botIds.slice(start, start + BOT_OWNER_BATCH) } } });

        const live = new Set(page.filter((row) => row.deletedAt === undefined).map((row) => row.botId as string));

        // A row cannot drop a field by patch, so a live row is written first and the tombstoned one deleted after: D1 writes
        // do not roll back together, and a failure between the two leaves both (readers take the live one), never neither.
        for (const owner of page) {
            if (owner.deletedAt === undefined) {
                continue;
            }

            if (!live.has(owner.botId as string)) {
                if (!spend(budget)) {
                    return;
                }

                await ctx.db.insert("botOwners", { botId: owner.botId, createdAt: owner.createdAt, ownerId: owner.ownerId });
                live.add(owner.botId as string);
            }

            if (!spend(budget)) {
                return;
            }

            await ctx.db.delete("botOwners", owner._id);
        }

        // A bot whose owner record was never written (`createBot` writes it after the bot, and the two do not commit
        // together) gets one, so its memories name their owner.
        const recorded = new Set(page.map((row) => row.botId as string));

        const batchBots = bots.slice(start, start + BOT_OWNER_BATCH);

        for (const bot of batchBots) {
            if (recorded.has(bot._id as string)) {
                continue;
            }

            if (!spend(budget)) {
                return;
            }

            await ctx.db.insert("botOwners", { botId: bot._id, createdAt: bot.createdAt, ownerId: userId });
        }
    }

    // A live record whose bot is gone (a delete that failed before its tombstone was written) is tombstoned now.
    if (!spend(budget)) {
        return;
    }

    const existing = new Set(botIds as string[]);

    const { page: liveRecords } = await ctx.db.botOwners.findMany({
        consistency: "primary",
        limit: ORPHAN_PAGE,
        where: { deletedAt: { isNull: true }, ownerId: userId },
    });

    for (const owner of liveRecords) {
        if (existing.has(owner.botId as string)) {
            continue;
        }

        if (!spend(budget)) {
            return;
        }

        await ctx.db.patch("botOwners", owner._id, { deletedAt: now });
    }
};

/** Deletes `userId`'s bot owner records whose bot was deleted more than {@link BOT_OWNER_TOMBSTONE_TTL_MS} before `now`. */
export const pruneBotOwnerTombstonesOf = async (ctx: Pick<MutationCtx, "db">, userId: string, now: number, budget: StatementBudget): Promise<void> => {
    // The read takes one statement and each delete another, so it reads no more rows than the budget can delete.
    if (!spend(budget) || budget.left === 0) {
        return;
    }

    const { page } = await ctx.db.botOwners.findMany({
        consistency: "primary",
        limit: Math.min(TOMBSTONE_PRUNE_PAGE, budget.left),
        where: { deletedAt: { lt: now - BOT_OWNER_TOMBSTONE_TTL_MS }, ownerId: userId },
    });

    for (const owner of page) {
        if (!spend(budget)) {
            return;
        }

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
            // One budget for both, so the run as a whole stays under the statement cap.
            const budget = { left: BOT_OWNER_SWEEP_STATEMENTS };

            await restoreLiveBotOwnersOf(ctx, userId, ctx.now, budget);
            await pruneBotOwnerTombstonesOf(ctx, userId, ctx.now, budget);
        }

        return null;
    });
