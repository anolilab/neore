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
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { planFor } from "../skills/bundle";
import { assertNoToolConfig, checkPluginFile } from "./install-action";
import { entryHash, skillContent, skillRowHash, triggerRowHash } from "./entry-hash";
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
            } else if (link.kind === "trigger") {
                const trigger = await ctx.db
                    .query("triggers")
                    .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(installId, link.entryKey)))
                    .first();

                currentHash = trigger ? await triggerRowHash(trigger) : "missing";
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
        assertNoToolConfig(entries);
        const incoming = await Promise.all(entries.map(async (entry) => ({ contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind })));
        const plan: Array<{ action: UpdateAction; entryKey: string }> = diffUpdate(installed.children, incoming);

        return {
            downgrade: isDowngrade(installed.version, header.version),
            installedVersion: installed.version,
            plan,
            targetVersion: header.version,
        };
    });

/**
 * Applies an update. Changed skills are rewritten in place; unchanged ones are left alone; an edited child, a child
 * that is not a skill, and any add or removal are reported as skipped (not applied yet). A downgrade needs
 * `confirmDowngrade`. If a step stops part-way the install stays `updating`, and repair handles it (not built yet).
 */
export const updatePlugin = authAction
    .input({
        confirmDowngrade: v.boolean(),
        contentHash: v.string().max(128),
        markdown: v.string().max(MAX_LENGTH.document),
    })
    .use(rateLimit("plugins/install"))
    .output(
        v.object({
            applied: v.array(v.string()),
            skipped: v.array(v.object({ action: vAction, entryKey: v.string() })),
            version: v.string(),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

        const { header, hash } = await checkPluginFile(args.markdown);

        if (hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "The file is not the one that was previewed. Preview it again before updating.");
        }

        const { userId } = ctx.user;
        const installed = await ctx.runQuery(internal.plugins.update.loadInstalledForUpdate, { pluginSlug: header.slug, userId });

        if (!installed) {
            throw new LunoraError("NOT_FOUND", `The plugin "${header.slug}" is not installed`);
        }

        if (isDowngrade(installed.version, header.version) && !args.confirmDowngrade) {
            throw new LunoraError(
                "BAD_REQUEST",
                `This moves "${header.slug}" from ${installed.version} back to ${header.version}. Confirm the downgrade to continue.`,
            );
        }

        const { entries } = await planFor(ctx, args.markdown, undefined);
        assertNoToolConfig(entries);
        const incoming = await Promise.all(entries.map(async (entry) => ({ contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind })));
        const plan = diffUpdate(installed.children, incoming);

        const generation = await ctx.runMutation(internal.plugins.update_apply.beginUpdate, {
            installId: installed.installId,
            targetVersion: header.version,
            userId,
        });

        const applied: string[] = [];
        const skipped: Array<{ action: UpdateAction; entryKey: string }> = [];

        for (const step of plan) {
            if (step.action === "same") {
                continue;
            }

            const entry = entries.find((candidate) => candidate.key === step.entryKey);

            if (step.action !== "update" || entry?.plan?.kind !== "skill") {
                skipped.push(step);
                continue;
            }

            const content = skillContent(entry.plan.create);

            await ctx.runMutation(internal.plugins.update_apply.updateSkillChild, {
                category: content.category,
                config: content.config,
                contentHash: await entryHash(entry),
                description: content.description,
                entryKey: step.entryKey,
                generation,
                icon: content.icon,
                installId: installed.installId,
                instructions: content.instructions,
                name: content.name,
                tags: content.tags,
                userId,
                variables: content.variables,
                version: content.version,
            });
            applied.push(step.entryKey);
        }

        await ctx.runMutation(internal.plugins.update_apply.finishUpdate, {
            generation,
            installId: installed.installId,
            version: header.version,
        });

        return { applied, skipped, version: header.version };
    });
