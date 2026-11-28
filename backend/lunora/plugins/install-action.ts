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
import { assertSelectionImportable, BundleImportError, runBundleImport } from "../skills/bundle-plan";
import { entryHash } from "./entry-hash";
import { requirePluginFeature } from "./gate";
import { childOps, importFailure } from "./install-ops";
import { bodyHash } from "./logic";

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
export const assertNoToolConfig = (entries: ReadonlyArray<{ plan?: { create?: unknown; kind: string }; title: string }>): void => {
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

    return { hash, header: parsed.bundle.plugin, name: parsed.bundle.name };
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

        requirePluginFeature(ctx.user.userId, "plugins");

        const { hash, header, name } = await checkPluginFile(args.markdown);
        const { entries } = await planFor(ctx, args.markdown, undefined);

        assertNoToolConfig(entries);
        // The rules install applies: a preview that lists an entry install would refuse is refused here, naming the problem.
        assertSelectionImportable(entries, new Set(entries.map((entry) => entry.key)));

        return {
            contentHash: hash,
            items: entries.map((entry) => {
                return { key: entry.key, kind: entry.kind, title: entry.title, warnings: entry.warnings };
            }),
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
    .output(
        v.object({
            installId: v.string(),
            items: v.array(v.object({ id: v.string(), key: v.string(), kind: vKind, title: v.string(), webhookSecret: v.optional(v.string()) })),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", organizationRefusal);
        }

        requirePluginFeature(ctx.user.userId, "plugins");

        const { hash, header } = await checkPluginFile(args.markdown);

        if (hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "The file is not the one that was previewed. Preview it again before installing.");
        }

        const { userId } = ctx.user;
        const claimKey = `${userId}:${header.slug}`;
        const claimedAt = await ctx.runMutation(internal.lib.claim_once.claimKeyFenced, {
            key: claimKey,
            scope: INSTALL_CLAIM_SCOPE,
            ttlMs: INSTALL_CLAIM_TTL_MS,
            userId,
        });

        if (claimedAt === null) {
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

            const ops = childOps(ctx, {
                generation,
                installId,
                intentFor: async (key, kind) =>
                    await ctx.runMutation(internal.plugins.install_steps.recordIntent, {
                        contentHash: hashByKey.get(key) ?? "",
                        entryKey: key,
                        generation,
                        installId,
                        kind,
                        userId,
                    }),
                isPremium,
                plan,
                userId,
                version: header.version,
            });

            let items: Awaited<ReturnType<typeof runBundleImport>>;

            try {
                items = await runBundleImport(entries, selected, ops, { keepOnRateLimit: true });
            } catch (error) {
                // A rate limit keeps the rows created so far, and repair finishes the rest. Rows the rollback could not remove keep the
                // install as `needs-repair` too; a clean rollback removes it.
                // The cleanup never replaces the import's own error: a cleanup that fails is swallowed, and the install is kept for repair.
                try {
                    if (error instanceof BundleImportError && (error.resumable || error.leftBehind.length > 0)) {
                        await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation, installId });
                    } else {
                        // A few links a call, so a large install stays inside one invocation's D1 queries.
                        let more = true;

                        while (more) {
                            const step = await ctx.runMutation(internal.plugins.install_steps.deleteInstall, { generation, installId });

                            more = step.hasMore;
                        }
                    }
                } catch {
                    await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation, installId }).catch(() => undefined);
                }

                throw importFailure(error);
            }

            // The children exist now: a failure to finish keeps the install and its links (deleting them would orphan the children),
            // and repair finishes it.
            try {
                await ctx.runMutation(internal.plugins.install_steps.finishInstall, { generation, installId });
            } catch (error) {
                await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation, installId }).catch(() => undefined);

                throw error;
            }

            return { installId, items };
        } finally {
            await ctx.runMutation(internal.lib.claim_once.releaseKey, { claimedAt, key: claimKey, scope: INSTALL_CLAIM_SCOPE }).catch(() => undefined);
        }
    });
