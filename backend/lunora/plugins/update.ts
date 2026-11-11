/**
 * Update, step one: the preview. It reads the installed children and the new file, and says what an update would do to each
 * child (`diffUpdate`). It writes nothing. Applying the update is the next step.
 *
 * A child's live hash is known only for skills; triggers and groups are reported as `unknown`, which the diff treats as
 * edited, so an update never overwrites them until they can be compared.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { planFor } from "../skills/bundle";
import { checkPluginFile } from "./install-action";
import { entryHash, skillRowHash } from "./entry-hash";
import { diffUpdate, isDowngrade, markerFor } from "./logic";
import type { UpdateAction } from "./logic";
import { vPluginItemKind } from "./validators";

const vAction = v.union(
    v.literal("create"),
    v.literal("delete"),
    v.literal("detach"),
    v.literal("keep-edited"),
    v.literal("report-group"),
    v.literal("same"),
    v.literal("update"),
);

/** The installed plugin and, for each child, the hash it was installed with and its live hash now. */
export const loadInstalledForUpdate = internalQuery
    .input({ pluginSlug: v.string().max(64), userId: v.string().max(128) })
    .output(
        v.union(
            v.null(),
            v.object({
                children: v.array(
                    v.object({
                        contentHash: v.string(),
                        currentHash: v.string(),
                        entryKey: v.string(),
                        kind: vPluginItemKind,
                    }),
                ),
                installId: v.string(),
                status: v.string(),
                version: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const install = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug: args.pluginSlug, userId: args.userId } });

        if (!install) {
            return null;
        }

        const installId = install._id as string;
        const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });
        const children: Array<{ contentHash: string; currentHash: string; entryKey: string; kind: "group" | "skill" | "trigger" }> = [];

        for (const link of page) {
            let currentHash = "unknown";

            if (link.kind === "skill") {
                const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, link.entryKey) } });

                currentHash = skill ? await skillRowHash(skill) : "missing";
            }

            children.push({ contentHash: link.contentHash, currentHash, entryKey: link.entryKey, kind: link.kind });
        }

        return { children, installId, status: install.status, version: install.version };
    });

export const previewUpdate = authAction
    .input({ markdown: v.string().max(MAX_LENGTH.document) })
    .output(
        v.object({
            downgrade: v.boolean(),
            installedVersion: v.string(),
            plan: v.array(v.object({ action: vAction, entryKey: v.string() })),
            targetVersion: v.string(),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

        const { header } = await checkPluginFile(args.markdown);
        const installed = await ctx.runQuery(internal.plugins.update.loadInstalledForUpdate, {
            pluginSlug: header.slug,
            userId: ctx.user.userId,
        });

        if (!installed) {
            throw new LunoraError("NOT_FOUND", `The plugin "${header.slug}" is not installed`);
        }

        if (installed.status !== "installed") {
            throw new LunoraError("CONFLICT", `The plugin "${header.slug}" is ${installed.status}, not installed. Repair it first.`);
        }

        const { entries } = await planFor(ctx, args.markdown, undefined);
        const incoming = await Promise.all(entries.map(async (entry) => ({ contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind })));
        const plan: Array<{ action: UpdateAction; entryKey: string }> = diffUpdate(installed.children, incoming);

        return {
            downgrade: isDowngrade(installed.version, header.version),
            installedVersion: installed.version,
            plan,
            targetVersion: header.version,
        };
    });
