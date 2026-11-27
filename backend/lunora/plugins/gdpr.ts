/**
 * The plugin tables' erasure for account deletion (called by `gdpr/steps/deletion-steps.ts`). Install rows and their
 * child links are the owner's bookkeeping. The children they point at (skills, triggers, groups) are erased by their
 * own steps, so this removes only the links and the installs.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { type BatchResult, deleteOneByOne } from "../gdpr/batch";

/**
 * Rows per table per call. Both tables are `.global()`, so every delete reads its row and then deletes it (two D1 statements) and
 * one invocation allows about 50: two page reads and up to 2 x 10 deletes at two each is 42.
 */
const PAGE = 10;

/** One batch of the person's links and installs. `hasMore` while either table may hold more; the workflow calls again. */
export const erasePluginsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: items } = await ctx.db.pluginItems.findMany({ consistency: "primary", limit: PAGE, where: { userId } });
    const { page: installs } = await ctx.db.pluginInstalls.findMany({ consistency: "primary", limit: PAGE, where: { userId } });

    await deleteOneByOne(items, async (row) => await ctx.db.delete("pluginItems", row._id));
    await deleteOneByOne(installs, async (row) => await ctx.db.delete("pluginInstalls", row._id));

    return { hasMore: items.length >= PAGE || installs.length >= PAGE };
};

/** Links read per page for the export. */
const EXPORT_PAGE = 100;

/** Installs a person can hold: one per plugin, so the list is small and read whole with the first page. */
const EXPORT_INSTALLS = 500;

/**
 * One page of the person's plugin links for the account export, and, with the first page, their installs. The export action reads
 * the pages itself (no workflow step result carries them, which a persisted step caps at 1 MiB). No content hashes: they say
 * nothing about the person.
 */
export const collectPluginsForExport = internalQuery
    .input({ cursor: v.optional(v.string().max(512)), userId: v.string() })
    .output(v.object({ continueCursor: v.optional(v.string()), installs: v.array(v.any()), items: v.array(v.any()) }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const installPage =
            cursor === undefined ? await ctx.db.pluginInstalls.findMany({ consistency: "primary", limit: EXPORT_INSTALLS, where: { userId } }) : undefined;
        const installs = installPage?.page ?? [];
        const page = await ctx.db.pluginItems.findMany({ consistency: "primary", cursor: cursor ?? null, limit: EXPORT_PAGE, where: { userId } });

        return {
            continueCursor: page.isDone || !page.continueCursor ? undefined : page.continueCursor,
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
            items: page.page.map((item) => {
                return { createdAt: item.createdAt, entryKey: item.entryKey, installId: item.installId, kind: item.kind, state: item.state };
            }),
        };
    });
