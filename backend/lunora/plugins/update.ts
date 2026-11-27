/**
 * Update, step one: the preview. It reads the installed children and the new file, and says what an update would do to each
 * child (`diffUpdate`). It writes nothing. Applying the update is the next step.
 *
 * Every child's live hash is read from its row (`liveHashOf`), so the diff tells an edited skill, trigger or group chat from an
 * unedited one.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalQuery } from "../_generated/server";
import { authAction, rateLimit } from "../lib/crpc";
import { requirePluginFeature } from "./gate";
import { requireOwnerShard } from "./owner-shard";
import { childOps, importFailure } from "./install-ops";
import { assertSelectionImportable, BundleImportError, runBundleImport } from "../skills/bundle-plan";
import { MAX_LENGTH } from "../lib/validators";
import { planFor } from "../skills/bundle";
import { assertNoToolConfig, checkPluginFile } from "./install-action";
import { entryHash, skillContent, skillRowHash } from "./entry-hash";
import { skillVisibility } from "../skills/access";
import { liveHashOf } from "./live-hash";
import type { SkillKeyCache } from "./live-hash";
import { diffUpdate, isDowngrade, markerFor } from "./logic";
import type { UpdateAction } from "./logic";
import { vPluginItemKind } from "./validators";

type GroupDeleteCursor = { cursor?: string; deltaCursor?: string; messagesDone: boolean; pinsDone: boolean; streamOrder?: number; streamsDone: boolean };

const vAction = v.union(v.literal("create"), v.literal("delete"), v.literal("detach"), v.literal("keep-edited"), v.literal("same"), v.literal("update"));

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
                /** The skills that exist now, by entry key: a group chat's participants must be among them or among the new skills. */
                skillIds: v.array(v.object({ entryKey: v.string(), skillId: v.string() })),
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
        const skillIds: { entryKey: string; skillId: string }[] = [];

        const skillKeys: SkillKeyCache = new Map();

        for (const link of page) {
            let currentHash: string;

            if (link.kind === "skill") {
                // Read once: the row gives the live hash, the slug and the visibility.
                const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: markerFor(installId, link.entryKey) } });

                currentHash = skill ? await skillRowHash(skill) : "missing";

                if (skill) {
                    skillKeys.set(skill._id as string, link.entryKey);
                    ownSlugs.push({ entryKey: link.entryKey, slug: skill.slug });
                    skillIds.push({ entryKey: link.entryKey, skillId: skill._id as string });

                    // Visibility is not in the content hash: a skill shared beyond its owner reads as edited, so the diff keeps it.
                    if (skillVisibility(skill) !== "private") {
                        currentHash = "shared";
                    }
                }
            } else {
                currentHash = await liveHashOf(ctx, installId, link, skillKeys);
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

        return { children, generation: install.generation, installId, ownSlugs, skillIds, status: install.status, version: install.version };
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

        requirePluginFeature(ctx.user.userId, "plugins");

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
 * Applies an update. Changed skills, triggers (schedule or webhook, a type change included) and group chats are rewritten in place, and
 * a skill records the new plugin version as its source; unchanged ones are left alone; an edited child is reported as skipped. A trigger
 * rewrite switches the trigger off; a webhook that a type change (or a signature scheme change) created returns its secret once in
 * `webhookSecrets`; when a later step fails it is not returned, and the person rotates it (`triggers.rotateWebhookSecret`). A group chat
 * rewrite keeps its messages. New children are created (skills, triggers, then new group chats, which name the plugin's skills by
 * entry key), and removed ones deleted or detached: a dropped group chat with no messages or pins is deleted, one that has either is
 * kept and detached from the plugin (and reported as skipped), and a skill such a group still names is kept the way it is for any
 * group chat. The order is: skill rewrites, creates, group rewrites, dropped group chats, dropped skills and triggers, then trigger
 * rewrites (webhook targets last), so a dropped skill is never judged against a group chat that is about to go, and a step that can
 * issue a webhook secret has as few steps after it as possible. An update whose group chat names a skill that does not exist
 * is refused before anything is written. A downgrade needs `confirmDowngrade`. If a step fails, the install goes back to `installed`
 * (or to `needs-repair` when new children were left behind) and the update can be run again; repair does not rewrite a group chat, it
 * marks the install partial, and running the update again finishes the group.
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
            /** The secret of a webhook an update created (its trigger changed type), shown once. */
            webhookSecrets: v.array(v.object({ entryKey: v.string(), secret: v.string() })),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

        requirePluginFeature(ctx.user.userId, "plugins");

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

        // An entry that cannot be planned (a trigger whose model is gone, for instance) has no content: any step but "same" for it would be
        // skipped while the new version is recorded.
        const unplanned = plan.filter((step) => {
            const entry = entries.find((candidate) => candidate.key === step.entryKey);

            return step.action !== "same" && entry !== undefined && entry.plan === undefined;
        });

        if (unplanned.length > 0) {
            throw new LunoraError(
                "BAD_REQUEST",
                unplanned
                    .map((step) => {
                        const entry = entries.find((candidate) => candidate.key === step.entryKey);

                        return `${entry?.title ?? step.entryKey}: ${entry?.problems.join(" ") || "it cannot be planned"}`;
                    })
                    .join(" | "),
            );
        }

        const createKeys = new Set(plan.filter((step) => step.action === "create").map((step) => step.entryKey));

        // A group chat that is created or rewritten names its participants by entry key. One that is not a live skill of the plugin (the
        // person deleted it) or a skill this update creates would leave a broken group, so the update is refused before it writes.
        const liveSkillKeys = new Set(installed.skillIds.map((row) => row.entryKey));
        const brokenGroups = plan.flatMap((step) => {
            const group = entries.find((candidate) => candidate.key === step.entryKey)?.plan;

            if ((step.action !== "create" && step.action !== "update") || group?.kind !== "group") {
                return [];
            }

            const names = [...group.create.participantKeys, ...(group.create.synthesizerKey === undefined ? [] : [group.create.synthesizerKey])];
            const missing = names.filter(
                (key) => !(createKeys.has(key) && entries.find((candidate) => candidate.key === key)?.plan?.kind === "skill") && !liveSkillKeys.has(key),
            );

            return missing.length === 0 ? [] : [`${step.entryKey} names ${[...new Set(missing)].join(", ")}`];
        });

        if (brokenGroups.length > 0) {
            throw new LunoraError(
                "UNPROCESSABLE",
                `A group chat names a skill that is not in the plugin any more (${brokenGroups.join("; ")}). Restore or reinstall that skill, or change the group chat.`,
            );
        }

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
        const webhookSecrets: { entryKey: string; secret: string }[] = [];
        let importDone = false;
        const skipped: { action: UpdateAction; entryKey: string }[] = [];
        const removals: { action: UpdateAction; entryKey: string }[] = [];
        const groupRewrites: { action: UpdateAction; entryKey: string }[] = [];
        const groupRemovals: { action: UpdateAction; entryKey: string }[] = [];
        const triggerRewrites: { action: UpdateAction; entryKey: string }[] = [];
        const isWebhookEntry = (entryKey: string): boolean => {
            const entry = entries.find((candidate) => candidate.key === entryKey);

            return entry?.plan?.kind === "trigger" && entry.plan.create.type === "webhook";
        };

        try {
            for (const step of plan) {
                if (step.action === "same") {
                    continue;
                }

                const entry = entries.find((candidate) => candidate.key === step.entryKey);
                const child = installed.children.find((row) => row.entryKey === step.entryKey);

                if (step.action === "create") {
                    continue;
                }

                if (step.action === "delete" || step.action === "detach") {
                    // Removal cannot be undone, so it waits until the new children are in: a failed create then loses nothing. A group chat
                    // goes first, so a skill it names is not judged against a group that is about to go.
                    if (child?.kind === "group") {
                        groupRemovals.push(step);
                    } else {
                        removals.push(step);
                    }

                    continue;
                }

                if (step.action === "update" && entry?.plan?.kind === "group") {
                    // After the new skills exist: the group may name one of them.
                    groupRewrites.push(step);
                    continue;
                }

                if (step.action === "update" && entry?.plan?.kind === "trigger") {
                    // Last, after every other step: a replaced webhook's new secret is returned only when the update succeeds.
                    triggerRewrites.push(step);
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
                    pluginVersion: header.version,
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
                    {
                        keepOnRateLimit: true,
                        // A new group chat may name a skill that already exists: its id is looked up by entry key.
                        knownIds: new Map(installed.skillIds.map((row) => [row.entryKey, row.skillId] as const)),
                    },
                );

                importDone = true;
                applied.push(...created.map((item) => item.key));

                // A new webhook's secret is issued at creation. It is returned with the result, never on a failure.
                for (const item of created) {
                    if (item.webhookSecret !== undefined) {
                        webhookSecrets.push({ entryKey: item.key, secret: item.webhookSecret });
                    }
                }
            }

            for (const step of groupRewrites) {
                const group = entries.find((candidate) => candidate.key === step.entryKey);

                if (group?.plan?.kind !== "group") {
                    continue;
                }

                const { debateRounds, mode, model, participantKeys, synthesizerKey, title } = group.plan.create;

                await ctx.runMutation(internal.plugins.update_apply.updateGroupChild, {
                    contentHash: await entryHash(group),
                    debateRounds,
                    entryKey: step.entryKey,
                    generation,
                    installId: installed.installId,
                    mode,
                    model,
                    participantKeys,
                    synthesizerKey,
                    title,
                    userId,
                });

                applied.push(step.entryKey);
            }

            for (const step of groupRemovals) {
                const { outcome, threadId } = await ctx.runMutation(internal.plugins.update_apply.retireGroupChild, {
                    detach: step.action === "detach",
                    entryKey: step.entryKey,
                    generation,
                    installId: installed.installId,
                    userId,
                });

                if (outcome === "kept") {
                    // It has messages or pins: kept, detached from the plugin, and reported.
                    skipped.push(step);
                } else if (outcome === "delete" && threadId !== undefined) {
                    // The action owns the pagination, as at uninstall: each incomplete page hands back where it stopped.
                    let next: GroupDeleteCursor | undefined;
                    let kept = false;

                    for (;;) {
                        const page = await ctx.runMutation(internal.agent.threads.deleteAllForThreadIdAsync, {
                            ...next,
                            detachSkills: false,
                            pluginInstallId: installed.installId,
                            threadId: threadId as Id<"threads">,
                        });

                        if (page.kept === true) {
                            kept = true;
                            break;
                        }

                        if (page.isDone) {
                            break;
                        }

                        if (!page.next) {
                            throw new Error("The group chat deletion stopped without saying where");
                        }

                        next = page.next;
                    }

                    // A message that landed after the check keeps the group (the delete detaches it, as at uninstall): reported, not applied.
                    await ctx.runMutation(internal.plugins.update_apply.dropGroupLink, { entryKey: step.entryKey, generation, installId: installed.installId });

                    if (kept) {
                        skipped.push(step);
                    } else {
                        applied.push(step.entryKey);
                    }
                } else {
                    applied.push(step.entryKey);
                }
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

            // Webhook targets after the others, so a step that can issue a secret has as few steps after it as possible.
            const webhookLast = triggerRewrites.toSorted((a, b) => Number(isWebhookEntry(a.entryKey)) - Number(isWebhookEntry(b.entryKey)));

            for (const step of webhookLast) {
                const entry = entries.find((candidate) => candidate.key === step.entryKey);

                if (entry?.plan?.kind !== "trigger") {
                    continue;
                }

                const { webhookSecret } = await ctx.runMutation(internal.plugins.update_apply.updateTriggerChild, {
                    ...entry.plan.create,
                    contentHash: await entryHash(entry),
                    entryKey: step.entryKey,
                    generation,
                    installId: installed.installId,
                    userId,
                });

                applied.push(step.entryKey);

                // A secret is issued only when a type or scheme change made a new webhook; it is returned once and never logged.
                if (webhookSecret !== undefined) {
                    webhookSecrets.push({ entryKey: step.entryKey, secret: webhookSecret });
                }
            }

            await ctx.runMutation(internal.plugins.update_apply.finishUpdate, {
                contentHash: hash,
                generation,
                installId: installed.installId,
                // A skipped or kept child still holds other content than the new version's.
                partial: skipped.length > 0,
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
                    partial: applied.length > 0 || skipped.length > 0 || importDone,
                })
                .catch(() => undefined);

            // A secret issued before the failure is not sent on the error, which may be logged: the trigger it belongs to is switched
            // off, and `triggers.rotateWebhookSecret` issues a new one.
            throw importFailure(error);
        }

        return { applied, skipped, version: header.version, webhookSecrets };
    });
