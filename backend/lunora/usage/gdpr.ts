/**
 * Erasure and retention of the usage tables (`usageDaily`, `usageReplies`,
 * `usageBackfill`), owned by the usage module.
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's
 * transaction.
 */
import { v } from "lunorash/server";

import type { MutationCtx } from "../_generated/server";
import { internalQuery } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { BATCH, full, type BatchResult } from "../gdpr/batch";

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

    // The member's share of organizations' usage goes with them (`.global()`: read through the table facade).
    const { page: organizationRows } = await ctx.db.usageOrganizationReplies.findMany({ limit: BATCH, where: { userId } });

    // A failed delete throws, as in every module's erasure: the step fails and is retried, and the retry reads what is
    // left, so it never reports done with a row still held. The organization's rows are deleted first: they sit outside
    // this transaction, and a retry after a failure among the user's rows finds them gone already.
    for (const row of organizationRows) {
        await ctx.db.delete("usageOrganizationReplies", row._id);
    }

    await Promise.all([
        ...days.map(async (row) => await ctx.db.delete("usageDaily", row._id)),
        ...keys.map(async (row) => await ctx.db.delete("usageReplies", row._id)),
        ...backfills.map(async (row) => await ctx.db.delete("usageBackfill", row._id)),
    ]);

    return { hasMore: full(days) || full(keys) || full(backfills) || organizationRows.length >= BATCH };
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

/** Every page of one of the user's usage tables, read one page at a time until the last (`readPage` reads one). */
export const collectUsageDailyPages = async <R = ExportedUsageRow>(
    readPage: (cursor: string | null) => Promise<{ cursor: string | null; rows: R[] }>,
): Promise<R[]> => {
    const rows: R[] = [];
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

/** One reply of the member's share of an organization's usage, as one export page reads it. */
export interface OrganizationUsageReply {
    costMicrodollars: number;
    date: string;
    organization: string;
    project?: string;
    tokens: number;
}

/** One exported row of the member's share of an organization's usage: a day's replies in one organization and project. */
export interface ExportedOrganizationUsageRow extends OrganizationUsageReply {
    replies: number;
}

/** Ledger rows one organization export page reads. */
export const ORGANIZATION_EXPORT_PAGE = 2000;

/** Pages the organization export reads at most: a million replies, far past what a member makes within the retention. */
const MAX_ORGANIZATION_EXPORT_PAGES = 500;

/**
 * The member's share of organizations' usage for the data export: every ledger row, a page at a time, summed per
 * organization, day and project as it is read, so the file holds a row per day rather than one per reply.
 */
export const collectOrganizationUsagePages = async (
    readPage: (cursor: string | null) => Promise<{ cursor: string | null; rows: OrganizationUsageReply[] }>,
): Promise<ExportedOrganizationUsageRow[]> => {
    const summed = new Map<string, ExportedOrganizationUsageRow>();
    let cursor: string | null = null;

    for (let page = 0; page < MAX_ORGANIZATION_EXPORT_PAGES; page += 1) {
        const result = await readPage(cursor);

        for (const row of result.rows) {
            const key = JSON.stringify([row.organization, row.date, row.project ?? null]);
            const current = summed.get(key) ?? { ...row, costMicrodollars: 0, replies: 0, tokens: 0 };

            current.costMicrodollars += row.costMicrodollars;
            current.replies += 1;
            current.tokens += row.tokens;
            summed.set(key, current);
        }

        if (result.cursor === null) {
            return [...summed.values()].toSorted((a, b) => a.date.localeCompare(b.date) || a.organization.localeCompare(b.organization));
        }

        cursor = result.cursor;
    }

    throw new Error("The organization usage history is too long to export in one file");
};

/** One page of the member's organization ledger rows for the data export; `cursor` is `null` after the last page. */
export const collectOrganizationUsageForExport = internalQuery
    .input({ cursor: v.union(v.string().max(MAX_LENGTH.cursor), v.null()), userId: v.string().max(MAX_LENGTH.id) })
    .output(
        v.object({
            cursor: v.union(v.string(), v.null()),
            rows: v.array(
                v.object({
                    costMicrodollars: v.number(),
                    date: v.string(),
                    organization: v.string(),
                    project: v.optional(v.string()),
                    tokens: v.number(),
                }),
            ),
        }),
    )
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const page = await ctx.db.usageOrganizationReplies.findMany({ cursor, limit: ORGANIZATION_EXPORT_PAGE, where: { userId } });

        return {
            cursor: page.isDone ? null : page.continueCursor,
            rows: page.page.map((row): OrganizationUsageReply => {
                return {
                    costMicrodollars: row.costMicrodollars,
                    date: row.date,
                    organization: row.organizationId,
                    tokens: row.tokens,
                    ...(row.projectKey !== undefined && { project: row.projectKey }),
                };
            }),
        };
    });
