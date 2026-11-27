/**
 * The plugin tables' erasure for account deletion (called by `gdpr/steps/deletion-steps.ts`). Install rows and their
 * child links are the owner's bookkeeping. The children they point at (skills, triggers, groups) are erased by their
 * own steps, so this removes only the links and the installs.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { type BatchResult, deleteOneByOne } from "../gdpr/batch";

/**
 * Rows per table per call. Both tables are `.global()`, so every delete is a D1 statement and one invocation allows about 50:
 * two reads and up to 2 x 20 deletes stay under it.
 */
const PAGE = 20;

/** One batch of the person's links and installs. `hasMore` while either table may hold more; the workflow calls again. */
export const erasePluginsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: items } = await ctx.db.pluginItems.findMany({ consistency: "primary", limit: PAGE, where: { userId } });
    const { page: installs } = await ctx.db.pluginInstalls.findMany({ consistency: "primary", limit: PAGE, where: { userId } });

    await deleteOneByOne(items, async (row) => await ctx.db.delete("pluginItems", row._id));
    await deleteOneByOne(installs, async (row) => await ctx.db.delete("pluginInstalls", row._id));

    return { hasMore: items.length >= PAGE || installs.length >= PAGE };
};

/** Rows read per page for the export. */
const EXPORT_PAGE = 500;

interface RowPage<T> {
    continueCursor?: string | null;
    isDone: boolean;
    page: T[];
}

/** Every row a read matches, a page at a time, from the primary (a single read stops at a page). */
const readAll = async <T>(read: (cursor: string | null) => Promise<RowPage<T>>): Promise<T[]> => {
    const rows: T[] = [];
    let cursor: string | null = null;

    for (;;) {
        const result: RowPage<T> = await read(cursor);

        rows.push(...result.page);

        if (result.isDone || !result.continueCursor) {
            return rows;
        }

        cursor = result.continueCursor;
    }
};

/** The person's plugin installs and the links of their entries, for the account export. No content hashes: they say nothing about the person. */
export const collectPluginsForExport = internalQuery
    .input({ userId: v.string() })
    .output(v.object({ installs: v.array(v.any()), items: v.array(v.any()) }))
    .query(async ({ args: { userId }, ctx }) => {
        const installs = await readAll(
            async (cursor) => await ctx.db.pluginInstalls.findMany({ consistency: "primary", cursor, limit: EXPORT_PAGE, where: { userId } }),
        );
        const items = await readAll(
            async (cursor) => await ctx.db.pluginItems.findMany({ consistency: "primary", cursor, limit: EXPORT_PAGE, where: { userId } }),
        );

        return {
            installs: installs.map((install) => {
                return {
                    id: install._id,
                    installedAt: install.installedAt,
                    pluginSlug: install.pluginSlug,
                    status: install.status,
                    updatedAt: install.updatedAt,
                    version: install.version,
                };
            }),
            items: items.map((item) => {
                return { createdAt: item.createdAt, entryKey: item.entryKey, installId: item.installId, kind: item.kind, state: item.state };
            }),
        };
    });
