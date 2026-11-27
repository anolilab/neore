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
import { requireOwnerShard } from "./owner-shard";
import { childOps, importFailure } from "./install-ops";
import { assertSelectionImportable, BundleImportError, runBundleImport } from "../skills/bundle-plan";
import { MAX_LENGTH } from "../lib/validators";
import { planFor } from "../skills/bundle";
import { assertNoToolConfig, checkPluginFile } from "./install-action";
import { entryHash, skillContent } from "./entry-hash";
import { skillVisibility } from "../skills/access";
import { liveHashOf } from "./live-hash";
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
                        /** A trigger child's stored type; empty for any other kind or a missing row. */
                        triggerType: v.string(),
                    }),
                ),
                generation: v.number(),
                installId: v.string(),
                ownSlugs: v.array(v.object({ entryKey: v.string(), slug: v.string() })),
                status: v.string(),
                version: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        // The children's live hashes are read from the owner's shard. On another shard every child would read as missing,
        // so the preview would call it edited and an update would detach it.
        requireOwnerShard(args.userId, "update");

        const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug: args.pluginSlug, userId: args.userId } });

        if (!install) {
            return null;
        }

        const installId = install._id as string;
        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });
        const children: { contentHash: string; currentHash: string; entryKey: string; kind: "group" | "skill" | "trigger"; triggerType: string }[] = [];
        const ownSlugs: { entryKey: string; slug: string }[] = [];

        for (const link of page) {
            let currentHash = await liveHashOf(ctx, installId, link);

            if (link.kind === "skill") {
                const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: markerFor(installId, link.entryKey) } });

                if (skill) {
                    ownSlugs.push({ entryKey: link.entryKey, slug: skill.slug });

                    // Visibility is not in the content hash: a skill shared beyond its owner reads as edited, so the diff keeps it.
                    if (skillVisibility(skill) !== "private") {
                        currentHash = "shared";
                    }
                }
            }

            let triggerType = "";

            if (link.kind === "trigger") {
                const trigger = await ctx.db
                    .query("triggers")
                    .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(installId, link.entryKey)))
                    .first();

                triggerType = trigger?.type ?? "";
            }

            children.push({ contentHash: link.contentHash, currentHash, entryKey: link.entryKey, kind: link.kind, triggerType });
        }

        return { children, generation: install.generation, installId, ownSlugs, status: install.status, version: install.version };
    });

export const previewUpdate = authAction
    .input({ markdown: v.string().max(MAX_LENGTH.document) })
    .output(
        v.object({
            downgrade: v.boolean(),
            generation: v.number(),
            installedVersion: v.string(),
            installId: v.string(),
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

        const { entries } = await planFor(ctx, args.markdown, undefined, { ownSlugs: installed.ownSlugs });

        assertNoToolConfig(entries);
        const incoming = await Promise.all(
            entries.map(async (entry) => {
                return { contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind };
            }),
        );
        const plan: { action: UpdateAction; entryKey: string }[] = diffUpdate(installed.children, incoming);

        return {
            downgrade: isDowngrade(installed.version, header.version),
            generation: installed.generation,
            installedVersion: installed.version,
            installId: installed.installId,
            plan,
            targetVersion: header.version,
        };
    });

/**
 * Applies an update. Changed skills are rewritten in place; unchanged ones are left alone; an edited child, a child
 * that is not a skill, and any add or removal are reported as skipped (not applied yet). A downgrade needs
 * `confirmDowngrade`. If a step fails, the install goes back to `installed` (or to `needs-repair` when new children were left behind) and the update can be run again.
 */
export const updatePlugin = authAction
    .input({
        confirmDowngrade: v.boolean(),
        contentHash: v.string().max(128),
        /** The generation `previewUpdate` returned: the update applies only to the install as that preview saw it. */
        expectedGeneration: v.number(),
        /** The install `previewUpdate` returned: a reinstall starts again at generation 1, so the generation alone does not name it. */
        expectedInstallId: v.string().max(128),
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

        const { hash, header } = await checkPluginFile(args.markdown);

        if (hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "The file is not the one that was previewed. Preview it again before updating.");
        }

        const { userId } = ctx.user;
        const installed = await ctx.runQuery(internal.plugins.update.loadInstalledForUpdate, { pluginSlug: header.slug, userId });

        if (!installed) {
            throw new LunoraError("NOT_FOUND", `The plugin "${header.slug}" is not installed`);
        }

        if (installed.generation !== args.expectedGeneration || installed.installId !== args.expectedInstallId) {
            throw new LunoraError("CONFLICT", "The plugin changed since it was previewed. Preview it again before updating.");
        }

        if (isDowngrade(installed.version, header.version) && !args.confirmDowngrade) {
            throw new LunoraError(
                "BAD_REQUEST",
                `This moves "${header.slug}" from ${installed.version} back to ${header.version}. Confirm the downgrade to continue.`,
            );
        }

        const { entries } = await planFor(ctx, args.markdown, undefined, { ownSlugs: installed.ownSlugs });

        assertNoToolConfig(entries);
        const incoming = await Promise.all(
            entries.map(async (entry) => {
                return { contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind };
            }),
        );
        const plan = diffUpdate(installed.children, incoming);

        // An update cannot create a group chat yet. Finishing it anyway would record the new version and file hash without the group, and
        // repair could not make it later, so it is refused before anything is written.
        const addedGroups = plan.filter((step) => step.action === "create" && entries.find((entry) => entry.key === step.entryKey)?.plan?.kind === "group");

        if (addedGroups.length > 0) {
            throw new LunoraError(
                "UNPROCESSABLE",
                `This version adds a group chat (${addedGroups.map((step) => step.entryKey).join(", ")}), which an update cannot create yet. Uninstall the plugin and install the new version instead.`,
            );
        }

        // The same for a changed child that cannot be rewritten in place (a webhook or event trigger, a group chat): it would be skipped while
        // the new version and file hash are recorded, and every later preview would offer the same update again.
        const unrewritable = plan.filter((step) => {
            const entry = entries.find((candidate) => candidate.key === step.entryKey);

            if (step.action === "report-group") {
                return entry !== undefined;
            }

            if (step.action !== "update" || entry?.plan?.kind !== "trigger") {
                return false;
            }

            // Either side being a webhook or an event trigger cannot be rewritten in place.
            const stored = installed.children.find((child) => child.entryKey === step.entryKey)?.triggerType;

            return entry.plan.create.type !== "schedule" || (stored !== undefined && stored !== "" && stored !== "schedule");
        });

        if (unrewritable.length > 0) {
            throw new LunoraError(
                "UNPROCESSABLE",
                `This version changes ${unrewritable.map((step) => step.entryKey).join(", ")}, which an update cannot rewrite in place yet. Uninstall the plugin and install the new version instead.`,
            );
        }

        // A child whose kind changed is a removal plus a creation under one key. Both halves are skipped when the old child is a group chat
        // (a group is never removed in place). A group on the new side was refused above.
        const groupSwap = new Set(
            plan
                .filter(
                    (step) =>
                        step.action === "create" &&
                        plan.some((other) => other.entryKey === step.entryKey && (other.action === "delete" || other.action === "detach")),
                )
                .map((step) => step.entryKey)
                .filter((key) => installed.children.find((row) => row.entryKey === key)?.kind === "group"),
        );
        const createKeys = new Set(plan.filter((step) => step.action === "create" && !groupSwap.has(step.entryKey)).map((step) => step.entryKey));

        // Checked before anything is written: a new item the planner blocked must not be dropped while the new version is recorded.
        if (createKeys.size > 0) {
            assertSelectionImportable(entries, createKeys);
        }

        const generation = await ctx.runMutation(internal.plugins.update_apply.beginUpdate, {
            expectedGeneration: args.expectedGeneration,
            installId: installed.installId,
            targetVersion: header.version,
            userId,
        });

        const applied: string[] = [];
        let importDone = false;
        const skipped: { action: UpdateAction; entryKey: string }[] = [];
        const removals: { action: UpdateAction; entryKey: string }[] = [];

        try {
            for (const step of plan) {
                if (step.action === "same") {
                    continue;
                }

                const entry = entries.find((candidate) => candidate.key === step.entryKey);
                const child = installed.children.find((row) => row.entryKey === step.entryKey);

                if (step.action === "create") {
                    // The creation half of a kind change whose old child is a group chat: reported, not applied.
                    if (!createKeys.has(step.entryKey)) {
                        skipped.push(step);
                    }

                    continue;
                }

                if (step.action === "delete" || step.action === "detach") {
                    if (child?.kind === "group" || groupSwap.has(step.entryKey)) {
                        skipped.push(step);
                    } else {
                        // Removal cannot be undone, so it waits until the new children are in: a failed create then loses nothing.
                        removals.push(step);
                    }

                    continue;
                }

                if (step.action === "update" && entry?.plan?.kind === "trigger" && entry.plan.create.type === "schedule") {
                    const { create } = entry.plan;

                    const updatedTrigger = await ctx.runMutation(internal.plugins.update_apply.updateTriggerChild, {
                        contentHash: await entryHash(entry),
                        cronExpression: create.cronExpression,
                        description: create.description,
                        entryKey: step.entryKey,
                        generation,
                        inputTemplate: create.inputTemplate,
                        installId: installed.installId,
                        model: create.model,
                        name: create.name,
                        searchMode: create.searchMode,
                        systemPrompt: create.systemPrompt,
                        timezone: create.timezone,
                        userId,
                    });

                    if (updatedTrigger) {
                        applied.push(step.entryKey);
                    } else {
                        skipped.push(step);
                    }

                    continue;
                }

                if (step.action !== "update" || entry?.plan?.kind !== "skill") {
                    skipped.push(step);
                    continue;
                }

                const content = skillContent(entry.plan.create);

                const rewritten = await ctx.runMutation(internal.plugins.update_apply.updateSkillChild, {
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
                    slug: content.slug,
                    tags: content.tags,
                    userId,
                    variables: content.variables,
                    version: content.version,
                });

                if (rewritten) {
                    applied.push(step.entryKey);
                } else {
                    skipped.push(step);
                }
            }

            if (createKeys.size > 0) {
                // New skills and triggers are created the way install creates them: intent first, then the create, then the link.
                const hashByKey = new Map(await Promise.all(entries.map(async (entry) => [entry.key, await entryHash(entry)] as const)));
                const created = await runBundleImport(
                    entries,
                    createKeys,
                    childOps(ctx, {
                        generation,
                        installId: installed.installId,
                        intentFor: async (key, kind) =>
                            await ctx.runMutation(internal.plugins.install_steps.recordIntent, {
                                contentHash: hashByKey.get(key) ?? "",
                                entryKey: key,
                                generation,
                                installId: installed.installId,
                                kind,
                                userId,
                            }),
                        isPremium: ctx.user.plan === "premium" || ctx.user.isAdmin === true,
                        plan: ctx.user.plan ?? undefined,
                        userId,
                        version: header.version,
                    }),
                    { keepOnRateLimit: true },
                );

                importDone = true;
                applied.push(...created.map((item) => item.key));
            }

            for (const step of removals) {
                const ids = { entryKey: step.entryKey, generation, installId: installed.installId, userId };

                // A skill that a group chat still names is kept, and reported.
                if (step.action === "delete" && !(await ctx.runMutation(internal.plugins.update_apply.removeChild, ids))) {
                    skipped.push(step);
                    continue;
                }

                if (step.action === "detach") {
                    await ctx.runMutation(internal.plugins.update_apply.detachChild, ids);
                }

                applied.push(step.entryKey);
            }

            await ctx.runMutation(internal.plugins.update_apply.finishUpdate, {
                contentHash: hash,
                generation,
                installId: installed.installId,
                version: header.version,
            });
        } catch (error) {
            // Each child step is one mutation, so what was done stays done and running the update again finishes the rest. A rate limit
            // or a rollback that left rows behind keeps the install for repair, with the new file's hash so repair takes the new file.
            // Once the new children are committed, a later failure must not declare the old version complete: the install is kept for repair with the new file.
            const keepForRepair = importDone || (error instanceof BundleImportError && (error.resumable || error.leftBehind.length > 0));

            await ctx
                .runMutation(internal.plugins.update_apply.failUpdate, {
                    contentHash: hash,
                    createKeys: [...createKeys],
                    generation,
                    installId: installed.installId,
                    keepForRepair,
                })
                .catch(() => undefined);

            throw importFailure(error);
        }

        return { applied, skipped, version: header.version };
    });
