/**
 * The plugin install procedures: `previewPlugin` (reads a file, writes nothing) and `installPlugin` (creates the children
 * in the import's order, each one intent-first, and links them under the install's generation).
 *
 * The file is checked twice: its header hash must match its body, and it must match the hash the preview returned, so
 * an install never runs on a file nobody previewed.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { authAction, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { parseBundleMarkdown } from "../skills/bundle-format";
import { planFor } from "../skills/bundle";
import type { BundleOps } from "../skills/bundle-plan";
import { assertSelectionImportable, BundleImportError, runBundleImport } from "../skills/bundle-plan";
import { entryHash } from "./entry-hash";
import { bodyHash, markerFor } from "./logic";

/** Ten minutes: the longest a claimed install may run before another attempt may start. */
const INSTALL_CLAIM_TTL_MS = 10 * 60 * 1000;
const INSTALL_CLAIM_SCOPE = "plugin-install";

const vKind = v.union(v.literal("skill"), v.literal("trigger"), v.literal("group"));

const TOOL_CONFIG_KEYS = ["additionalTools", "disabledTools"] as const;

/** Whether a skill's config adds or removes tools. A plugin skill may not: its tools are the person's, not its author's. */
export const refusesToolConfig = (config: unknown): boolean => {
    if (typeof config !== "object" || config === null) {
        return false;
    }

    return TOOL_CONFIG_KEYS.some((key) => {
        const value = Reflect.get(config, key);

        return Array.isArray(value) && value.length > 0;
    });
};

/** Refuses a plugin whose skills set tools, naming the first one. */
export const assertNoToolConfig = (entries: ReadonlyArray<{ plan?: { kind: string; create?: unknown }; title: string }>): void => {
    const offender = entries.find(
        (entry) => entry.plan?.kind === "skill" && refusesToolConfig((entry.plan.create as { config?: unknown } | undefined)?.config),
    );

    if (offender) {
        throw new LunoraError("BAD_REQUEST", `"${offender.title}" sets tools. A plugin skill cannot add or remove tools.`);
    }
};

const organizationRefusal = "Organization plugin installs are not available yet";

/** Refuses a file that is not a plugin, or whose body no longer matches its header. Returns the hash of the body. */
export const checkPluginFile = async (markdown: string) => {
    const parsed = parseBundleMarkdown(markdown);

    if (!parsed.ok) {
        throw new LunoraError("BAD_REQUEST", parsed.errors.join("; "));
    }

    if (!parsed.bundle.plugin) {
        throw new LunoraError("BAD_REQUEST", "This file is not a plugin. Import it as a bundle instead.");
    }

    const hash = await bodyHash(markdown);

    if (hash !== parsed.bundle.plugin.contentHash) {
        throw new LunoraError("BAD_REQUEST", "The file does not match its own content hash. It was changed after it was made.");
    }

    return { header: parsed.bundle.plugin, hash, name: parsed.bundle.name };
};

export const previewPlugin = authAction
    .input({ markdown: v.string().max(MAX_LENGTH.document) })
    .output(
        v.object({
            contentHash: v.string(),
            items: v.array(v.object({ key: v.string(), kind: vKind, title: v.string(), warnings: v.array(v.string()) })),
            name: v.string(),
            pluginSlug: v.string(),
            pluginVersion: v.string(),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", organizationRefusal);
        }

        const { header, hash, name } = await checkPluginFile(args.markdown);
        const { entries } = await planFor(ctx, args.markdown, undefined);
        assertNoToolConfig(entries);

        return {
            contentHash: hash,
            items: entries.map((entry) => ({ key: entry.key, kind: entry.kind, title: entry.title, warnings: entry.warnings })),
            name,
            pluginSlug: header.slug,
            pluginVersion: header.version,
        };
    });

export const installPlugin = authAction
    .input({
        contentHash: v.string().max(128),
        markdown: v.string().max(MAX_LENGTH.document),
    })
    .use(rateLimit("plugins/install"))
    .output(v.object({ installId: v.string(), items: v.array(v.object({ id: v.string(), key: v.string(), kind: vKind, title: v.string() })) }))
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", organizationRefusal);
        }

        const { header, hash } = await checkPluginFile(args.markdown);

        if (hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "The file is not the one that was previewed. Preview it again before installing.");
        }

        const { userId } = ctx.user;
        const claimKey = `${userId}:${header.slug}`;
        const claimed = await ctx.runMutation(internal.lib.claim_once.claimKey, {
            key: claimKey,
            scope: INSTALL_CLAIM_SCOPE,
            ttlMs: INSTALL_CLAIM_TTL_MS,
            userId,
        });

        if (!claimed) {
            throw new LunoraError("CONFLICT", `The plugin "${header.slug}" is already being installed.`);
        }

        try {
            const { entries } = await planFor(ctx, args.markdown, undefined);
            assertNoToolConfig(entries);
            const selected = new Set(entries.map((entry) => entry.key));
            const hashByKey = new Map(await Promise.all(entries.map(async (entry) => [entry.key, await entryHash(entry)] as const)));

            assertSelectionImportable(entries, selected);

            const { generation, installId } = await ctx.runMutation(internal.plugins.install_steps.createInstallRow, {
                contentHash: hash,
                pluginSlug: header.slug,
                userId,
                version: header.version,
            });

            const plan = ctx.user.plan ?? undefined;
            const isPremium = plan === "premium" || ctx.user.isAdmin === true;

            /** One child: its intent is recorded first, then the create runs with the marker, then its link is set. */
            const linked = async <T extends { id: string }>(kind: "group" | "skill" | "trigger", key: string, create: (intentId: string) => Promise<T>) => {
                const intentId = await ctx.runMutation(internal.plugins.install_steps.recordIntent, {
                    contentHash: hashByKey.get(key) ?? "",
                    entryKey: key,
                    generation,
                    installId,
                    kind,
                    userId,
                });
                const created = await create(intentId);

                await ctx.runMutation(internal.plugins.install_steps.recordCreated, { generation, installId, intentId, itemId: created.id });

                return created;
            };

            const link = { pluginInstallId: installId };
            const ops: BundleOps = {
                createGroupChat: async (group, key) => {
                    const created = await linked("group", key, async () => {
                        const { threadId } = await ctx.runMutation(internal.chat.group.functions.createPluginGroupChat, {
                            ...group,
                            ...link,
                            pluginMarker: markerFor(installId, key),
                            plan,
                            userId,
                        });

                        return { id: threadId };
                    });

                    return created.id;
                },
                createSkill: async (skill, key) => {
                    const created = await linked("skill", key, async () => ({
                        id: await ctx.runMutation(internal.skills.create_skill.createPluginSkill, {
                            ...skill,
                            ...link,
                            enabled: false,
                            isPremium,
                            pluginMarker: markerFor(installId, key),
                            plan,
                            source: { type: "plugin", version: header.version },
                            userId,
                            visibility: "private",
                        }),
                    }));

                    return created.id;
                },
                createTrigger: async (trigger, key) => {
                    const created = await linked("trigger", key, async () => {
                        const { triggerId, webhookSecret } = await ctx.runMutation(internal.triggers.functions.createPluginTrigger, {
                            ...trigger,
                            ...link,
                            pluginMarker: markerFor(installId, key),
                            plan,
                            userId,
                        });

                        return { id: triggerId, webhookSecret };
                    });

                    return { triggerId: created.id, ...(created.webhookSecret !== undefined && { webhookSecret: created.webhookSecret }) };
                },
                deleteGroupChat: async (threadId) => await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: threadId, kind: "group", userId }),
                deleteSkill: async (skillId) => await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: skillId, kind: "skill", userId }),
                deleteTrigger: async (triggerId) =>
                    await ctx.runMutation(internal.skills.bundle.removeImportedItem, { id: triggerId, kind: "trigger", userId }),
            };

            try {
                const items = await runBundleImport(entries, selected, ops);

                await ctx.runMutation(internal.plugins.install_steps.finishInstall, { generation, installId });

                return { installId, items };
            } catch (error) {
                // Rows the rollback could not remove keep the install as `needs-repair`; a clean rollback removes it.
                if (error instanceof BundleImportError && error.leftBehind.length > 0) {
                    await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation, installId });
                } else {
                    await ctx.runMutation(internal.plugins.install_steps.deleteInstall, { generation, installId });
                }

                throw error instanceof BundleImportError ? new LunoraError("BAD_REQUEST", error.message) : error;
            }
        } finally {
            await ctx.runMutation(internal.lib.claim_once.releaseKey, { key: claimKey, scope: INSTALL_CLAIM_SCOPE }).catch(() => undefined);
        }
    });
