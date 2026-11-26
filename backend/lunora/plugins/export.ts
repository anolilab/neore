/**
 * Export: a bundle that selects exactly the children of one installed plugin, all unedited and created, is written as that
 * plugin's own file (`bundle: 2` with the plugin header). Any other selection is a plain bundle with no header.
 *
 * The header's hash is the hash of the body (`bodyHash`), so the header describes the file it is written into. A header
 * is a label: an install still recomputes the hash from the file.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";
import { liveHashOf } from "./live-hash";
import { isCompletePluginExport } from "./logic";

/** An entry key whose part after the kind is a bare position: an install made before declared keys. */
const POSITIONAL_KEY_RE = /^\d+$/u;

export interface PluginHeader {
    contentHash: string;
    slug: string;
    version: string;
}

/** Rewrites a plain bundle's header into a plugin file's. The body is untouched, so its hash does not change. */
export const withPluginHeader = (markdown: string, header: PluginHeader): string =>
    markdown.replace(/^bundle: 1\n/mu, `bundle: 2\nplugin: ${header.slug}\npluginVersion: ${header.version}\ncontentHash: ${header.contentHash}\n`);

/**
 * The installed plugin a selection is exactly, or null. The check reads the picked items: they must all belong to one
 * install, and that install's children must be the picks, each one linked, unedited and with no update pending.
 */
export const pluginForSelection = internalQuery
    .input({
        groupChatIds: v.array(v.string().max(128)),
        skillIds: v.array(v.string().max(128)),
        triggerIds: v.array(v.string().max(128)),
        userId: v.string().max(128),
    })
    .output(v.union(v.null(), v.object({ keys: v.array(v.object({ id: v.string(), key: v.string() })), slug: v.string(), version: v.string() })))
    .query(async ({ args, ctx }) => {
        const picked = [...args.skillIds, ...args.triggerIds, ...args.groupChatIds];

        if (picked.length === 0) {
            return null;
        }

        const installIds = new Set<string>();

        for (const id of args.skillIds) {
            const row = await ctx.db.skills.findFirst({ where: { _id: id as Id<"skills"> } });

            if (!row || row.userId !== args.userId || !row.pluginInstallId) {
                return null;
            }

            installIds.add(row.pluginInstallId);
        }

        for (const id of args.triggerIds) {
            const row = await ctx.db.get("triggers", id as Id<"triggers">);

            if (!row || row.userId !== args.userId || !row.pluginInstallId) {
                return null;
            }

            installIds.add(row.pluginInstallId);
        }

        for (const id of args.groupChatIds) {
            const row = await ctx.db.get("threads", id as Id<"threads">);

            if (!row || row.userId !== args.userId || !row.pluginInstallId) {
                return null;
            }

            installIds.add(row.pluginInstallId);
        }

        if (installIds.size !== 1) {
            return null;
        }

        const [installId] = installIds;

        if (installId === undefined) {
            return null;
        }

        const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId as Id<"pluginInstalls"> } });

        if (!install || install.userId !== args.userId) {
            return null;
        }

        const { page: links } = await ctx.db.pluginItems.findMany({ where: { installId } });
        const children = [];

        for (const link of links) {
            const currentHash = await liveHashOf(ctx, installId, link);

            children.push({ contentHash: link.contentHash, currentHash, id: link.itemId ?? "", pendingHash: link.pendingHash, state: link.state });
        }

        const pickedSet = new Set(picked);

        if (!isCompletePluginExport({ status: install.status }, children, pickedSet)) {
            return null;
        }

        const keys: Array<{ id: string; key: string }> = [];

        for (const link of links) {
            if (link.itemId === undefined || !pickedSet.has(link.itemId)) {
                continue;
            }

            // The entry key is `<kind>:<declared key>`. A bare position is an install made before declared keys: it has no
            // stable key to write into a file, so the selection is exported as a plain bundle instead.
            const key = link.entryKey.slice(link.kind.length + 1);

            if (POSITIONAL_KEY_RE.test(key)) {
                return null;
            }

            keys.push({ id: link.itemId, key });
        }

        return { keys, slug: install.pluginSlug, version: install.version };
    });
