/**
 * Erasure and retention of the usage tables (`usageDaily`, `usageReplies`,
 * `usageBackfill`), owned by the usage module.
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's
 * transaction. Typed ids only: an `Id<TableName>` would read as a write to
 * every table.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { BATCH, full, type BatchResult } from "../gdpr/batch";
import { gdprLogger } from "../lib/logger";

/** Deletes a usage row that may already be gone (a retried round, or a dangling id). */
const deleteQuietly = async (
    ctx: MutationCtx,
    id: Id<"usageDaily"> | Id<"usageReplies"> | Id<"usageBackfill">,
    what: "usageBackfill" | "usageDaily" | "usageReplies",
): Promise<void> => {
    await ctx.db.delete(what, id as Id<"usageDaily">).catch((error: unknown) => {
        gdprLogger.error(`Failed to delete ${what} ${id}:`, error);
    });
};

/**
 * One batch of the user's per-day rollup (`usageDaily`), the keys of the replies
 * it counted (`usageReplies`) and the backfill's position (`usageBackfill`).
 * `hasMore` while any batch came back full. A step still running finds its
 * backfill row gone and stops.
 */
export const eraseUsageForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const [days, keys, backfills] = await Promise.all([
        ctx.db
            .query("usageDaily")
            .withIndex("by_user_date", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageReplies")
            .withIndex("by_user_reply", (q) => q.eq("userId", userId))
            .take(BATCH),
        ctx.db
            .query("usageBackfill")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .take(BATCH),
    ]);

    await Promise.all([
        ...days.map(async (row) => await deleteQuietly(ctx, row._id, "usageDaily")),
        ...keys.map(async (row) => await deleteQuietly(ctx, row._id, "usageReplies")),
        ...backfills.map(async (row) => await deleteQuietly(ctx, row._id, "usageBackfill")),
    ]);

    return { hasMore: full(days) || full(keys) || full(backfills) };
};

/**
 * Retention (`gdpr/retention.ts`): one batch of `usageDaily` rows dated before
 * `cutoffDate` (YYYY-MM-DD). Returns how many were deleted.
 */
export const pruneUsageDaysBefore = async (ctx: MutationCtx, cutoffDate: string, limit: number): Promise<number> => {
    const { page: days } = await ctx.db.usageDaily.findMany({
        limit,
        orderBy: [{ date: "asc" }],
        where: { date: { lt: cutoffDate } },
    });

    await Promise.all(days.map(async (row) => await ctx.db.delete("usageDaily", row._id)));

    return days.length;
};

/** Usage rows one export page reads. */
export const USAGE_EXPORT_PAGE = 1000;

/** Pages one export reads at most: past the rollup's retention, a year of a busy user's day, skill and project rows. */
const MAX_USAGE_EXPORT_PAGES = 200;

/** One exported usage row: the day, what it counts, and what it is filed under. */
export interface ExportedUsageRow {
    costMicrodollars: number;
    date: string;
    project?: string;
    replies: number;
    skill: string;
    tokens: number;
}

/** One page of the user's usage rollup for the data export, oldest first; `cursor` is `null` after the last page. */
export const collectUsageDailyForExport = internalQuery
    .input({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            rows: v.array(
                v.object({
                    costMicrodollars: v.number(),
                    date: v.string(),
                    project: v.optional(v.string()),
                    replies: v.number(),
                    skill: v.string(),
                    tokens: v.number(),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db.usageDaily.findMany({ cursor, limit: USAGE_EXPORT_PAGE, orderBy: [{ date: "asc" }], where: { userId } });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            rows: page.page.map((row): ExportedUsageRow => {
                return {
                    costMicrodollars: row.costMicrodollars,
                    date: row.date,
                    replies: row.replies,
                    skill: row.skillName ?? row.skillKey,
                    tokens: row.tokens,
                    ...(row.projectKey !== undefined && row.projectKey !== null && { project: row.projectKey }),
                };
            }),
        };
    });

/** Every page of the user's usage rollup, read one page at a time until the last (`readPage` reads one). */
export const collectUsageDailyPages = async (
    readPage: (cursor: string | null) => Promise<{ cursor: string | null; rows: ExportedUsageRow[] }>,
): Promise<ExportedUsageRow[]> => {
    const rows: ExportedUsageRow[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MAX_USAGE_EXPORT_PAGES; page += 1) {
        const result = await readPage(cursor);

        rows.push(...result.rows);

        if (result.cursor === null) {
            return rows;
        }

        cursor = result.cursor;
    }

    throw new Error("The usage history is too long to export in one file");
};
