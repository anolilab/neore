/**
 * The plugin tables' erasure for account deletion (called by `gdpr/steps/deletion-steps.ts`). Install rows and their
 * child links are the owner's bookkeeping. The children they point at (skills, triggers, groups) are erased by their
 * own steps, so this removes only the links and the installs.
 */
import { v } from "lunorash/server";

import { internalQuery, type MutationCtx } from "../_generated/server";
import { type BatchResult, deleteOneByOne } from "../gdpr/batch";

/**
 * Rows per table per call. The tables are `.global()`, so every delete reads its row and then deletes it (two D1 statements) and
 * one invocation allows about 50: three page reads and up to 3 x 7 deletes at two each is 45.
 */
const PAGE = 7;

/** One batch of the person's links, installs and install slots. `hasMore` while either table may hold more; the workflow calls again. */
export const erasePluginsForUser = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const { page: items } = await ctx.db.pluginItems.findMany({ consistency: "primary", limit: PAGE, where: { userId } });
    const { page: installs } = await ctx.db.pluginInstalls.findMany({ consistency: "primary", limit: PAGE, where: { userId } });

    const { page: slots } = await ctx.db.pluginInstallSlots.findMany({ consistency: "primary", limit: PAGE, where: { userId } });

    await deleteOneByOne(slots, async (row) => await ctx.db.delete("pluginInstallSlots", row._id));
    await deleteOneByOne(items, async (row) => await ctx.db.delete("pluginItems", row._id));
    await deleteOneByOne(installs, async (row) => await ctx.db.delete("pluginInstalls", row._id));

    return { hasMore: items.length >= PAGE || installs.length >= PAGE || slots.length >= PAGE };
};

/** Rows read per page for the export, installs and links alike. */
const EXPORT_PAGE = 100;

/**
 * One page of the person's plugin data for the account export: installs first, then links. A cursor names its table
 * (`i:` installs, `t:` links) and carries that table's own cursor, so each is followed to its end across calls. `readBytes` is
 * the page's size as read, for the export action's read budget. The action reads the pages itself (no workflow step result
 * carries them, which a persisted step caps at 1 MiB). No content hashes: they say nothing about the person.
 */
export const collectPluginsForExport = internalQuery
    .input({ cursor: v.optional(v.string().max(600)), userId: v.string() })
    .output(v.object({ continueCursor: v.optional(v.string()), installs: v.array(v.any()), items: v.array(v.any()), readBytes: v.number() }))
    .query(async ({ args: { cursor, userId }, ctx }) => {
        const size = (rows: unknown[]): number => new TextEncoder().encode(JSON.stringify(rows)).byteLength;

        if (cursor === undefined || cursor.startsWith("i:")) {
            const own = cursor === undefined || cursor === "i:" ? null : cursor.slice(2);
            const page = await ctx.db.pluginInstalls.findMany({ consistency: "primary", cursor: own, limit: EXPORT_PAGE, where: { userId } });
            const installs = page.page.map((install) => {
                return {
                    id: install._id,
                    installedAt: install.installedAt,
                    pluginSlug: install.pluginSlug,
                    status: install.status,
                    updatedAt: install.updatedAt,
                    version: install.version,
                };
            });

            return {
                continueCursor: page.isDone || !page.continueCursor ? "t:" : `i:${page.continueCursor}`,
                installs,
                items: [],
                readBytes: size(page.page),
            };
        }

        const own = cursor === "t:" ? null : cursor.slice(2);
        const page = await ctx.db.pluginItems.findMany({ consistency: "primary", cursor: own, limit: EXPORT_PAGE, where: { userId } });

        return {
            continueCursor: page.isDone || !page.continueCursor ? undefined : `t:${page.continueCursor}`,
            installs: [],
            items: page.page.map((item) => {
                return {
                    createdAt: item.createdAt,
                    entryKey: item.entryKey,
                    installId: item.installId,
                    itemId: item.itemId,
                    kind: item.kind,
                    state: item.state,
                };
            }),
            readBytes: size(page.page),
        };
    });
