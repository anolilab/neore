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
import { skillRowHash } from "./entry-hash";
import { isCompletePluginExport, markerFor } from "./logic";

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
    .output(v.union(v.null(), v.object({ slug: v.string(), version: v.string() })))
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
            // Only a skill's live content is known; a trigger or group reads as "unknown", which is not unedited.
            const skill = link.kind === "skill" ? await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, link.entryKey) } }) : null;
            const currentHash = skill ? await skillRowHash(skill) : "unknown";

            children.push({ contentHash: link.contentHash, currentHash, id: link.itemId ?? "", pendingHash: link.pendingHash, state: link.state });
        }

        const exact = isCompletePluginExport({ status: install.status }, children, new Set(picked));

        return exact ? { slug: install.pluginSlug, version: install.version } : null;
    });
