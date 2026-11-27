/**
 * Repair with resume. Two steps:
 *   1. `beginRepair` (mutation) links every child that exists (`repairRows`), takes the lease for what is left (a new
 *      generation, so a stale action stops), and returns the children that still need creating with their intent rows.
 *   2. `repairPlugin` (action) takes the file again, checks it is the one the install was made from, creates only the
 *      missing children through the same child operations as install, and finishes the install or keeps it for repair.
 *
 * The file is needed because a child that never existed can only be made from its entry in the file.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { assertSelectionImportable, runBundleImport } from "../skills/bundle-plan";
import { planFor } from "../skills/bundle";
import { assertNoToolConfig, checkPluginFile } from "./install-action";
import { childOps, importFailure } from "./install-ops";
import { entryHash } from "./entry-hash";
import { LEASE_MS } from "./logic";
import { requireOwnerShard } from "./owner-shard";
import { repairableNow, repairRows } from "./repair";
import { vPluginItemKind } from "./validators";

const vEntry = v.object({ contentHash: v.string().max(128), entryKey: v.string().max(256), kind: vPluginItemKind });

export const beginRepair = internalMutation
    .input({ contentHash: v.string().max(128), entries: v.optional(v.array(vEntry)), pluginSlug: v.string().max(64), userId: v.string().max(128) })
    .output(
        v.object({
            existing: v.array(v.object({ entryKey: v.string(), itemId: v.string() })),
            generation: v.number(),
            installId: v.string(),
            linked: v.number(),
            missing: v.array(v.object({ entryKey: v.string(), intentId: v.string(), kind: vPluginItemKind })),
            status: v.union(v.literal("installed"), v.literal("needs-repair")),
        }),
    )
    .mutation(async ({ args, ctx }) => await beginRepairRows(ctx, args.userId, args.pluginSlug, args.contentHash, args.entries));

export const beginRepairRows = async (
    ctx: MutationCtx,
    userId: string,
    pluginSlug: string,
    contentHash: string,
    /** Every entry the file would create. One with no row yet (an install stopped before it was reached) gets an intent row. */
    entries: { contentHash: string; entryKey: string; kind: "group" | "skill" | "trigger" }[] = [],
): Promise<{
    existing: { entryKey: string; itemId: string }[];
    generation: number;
    installId: string;
    linked: number;
    missing: { entryKey: string; intentId: string; kind: "group" | "skill" | "trigger" }[];
    status: "installed" | "needs-repair";
}> => {
    requireOwnerShard(userId, "repair");

    const install = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    // Repair may only use the file this install was made from (or last updated to). Any other file would create children from different content.
    // A stopped update is the exception: its repair creates nothing from the file, and the stored hash is still the old file's.
    if (install.status !== "updating" && install.contentHash !== contentHash) {
        throw new LunoraError("CONFLICT", "This is not the file the plugin was installed from. Preview it again to repair it.");
    }

    const installId = install._id as string;

    // An install stopped by a rate limit has rows only for the entries it reached; the rest get theirs now, so none is skipped.
    // Not for a stopped update: its file was not checked above, so it may not add children.
    if (install.status !== "updating" && repairableNow(install, ctx.now)) {
        const { page: existingRows } = await ctx.db.pluginItems.findMany({ where: { installId } });
        const known = new Set(existingRows.map((row) => row.entryKey));

        for (const entry of entries) {
            if (known.has(entry.entryKey)) {
                continue;
            }

            await ctx.db.insert("pluginItems", {
                contentHash: entry.contentHash,
                createdAt: ctx.now,
                entryKey: entry.entryKey,
                installId,
                kind: entry.kind,
                state: "intent",
                userId,
            });
        }
    }

    const result = await repairRows(ctx, userId, pluginSlug);
    const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });
    const existing = page.flatMap((row) =>
        row.state === "created" && row.kind === "skill" && row.itemId ? [{ entryKey: row.entryKey, itemId: row.itemId }] : [],
    );
    const missing = page
        .filter((row) => row.state === "intent" && result.missing.includes(row.entryKey))
        .map((row) => {
            return { entryKey: row.entryKey, intentId: row._id as string, kind: row.kind };
        });

    if (result.status === "installed" || missing.length === 0) {
        return { existing, generation: install.generation, installId, linked: result.linked, missing: [], status: result.status };
    }

    // Takeover: the next generation and a fresh lease, so an action started before this one writes nothing more and no other
    // repair or uninstall starts while this one creates children. The action ends it with `finishInstall` or `markNeedsRepair`.
    const generation = install.generation + 1;

    await ctx.db.patch("pluginInstalls", install._id as Id<"pluginInstalls">, {
        generation,
        leaseUntil: ctx.now + LEASE_MS,
        status: "installing",
        updatedAt: ctx.now,
    });

    return { existing, generation, installId, linked: result.linked, missing, status: "needs-repair" };
};

export const repairPlugin = authAction
    .input({
        contentHash: v.string().max(128),
        markdown: v.string().max(MAX_LENGTH.document),
        pluginSlug: v.string().max(64),
    })
    .output(
        v.object({
            created: v.array(v.string()),
            status: v.union(v.literal("installed"), v.literal("needs-repair")),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

        const { hash, header } = await checkPluginFile(args.markdown);

        if (header.slug !== args.pluginSlug || hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "This is not the file the plugin was installed from. Preview it again to repair it.");
        }

        const { userId } = ctx.user;
        const { entries } = await planFor(ctx, args.markdown, undefined);

        assertNoToolConfig(entries);

        const planned = await Promise.all(
            entries
                .filter((entry) => entry.plan)
                .map(async (entry) => {
                    return { contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind };
                }),
        );
        const begun = await ctx.runMutation(internal.plugins.repair_resume.beginRepair, {
            contentHash: hash,
            entries: planned,
            pluginSlug: args.pluginSlug,
            userId,
        });

        if (begun.missing.length === 0) {
            return { created: [], status: begun.status };
        }

        const missingKeys = new Set(begun.missing.map((entry) => entry.entryKey));
        const intentByKey = new Map(begun.missing.map((entry) => [entry.entryKey, entry.intentId] as const));

        assertSelectionImportable(entries, missingKeys);

        const plan = ctx.user.plan ?? undefined;
        const isPremium = plan === "premium" || ctx.user.isAdmin === true;
        const ops = childOps(ctx, {
            generation: begun.generation,
            installId: begun.installId,
            intentFor: async (key) => {
                const intentId = intentByKey.get(key);

                if (intentId === undefined) {
                    throw new LunoraError("CONFLICT", `No intent row for "${key}"`);
                }

                return intentId;
            },
            isPremium,
            plan,
            userId,
            version: header.version,
        });

        try {
            const created = await runBundleImport(entries, missingKeys, ops, {
                keepOnRateLimit: true,
                knownIds: new Map(begun.existing.map((row) => [row.entryKey, row.itemId] as const)),
            });

            await ctx.runMutation(internal.plugins.install_steps.finishInstall, { generation: begun.generation, installId: begun.installId });

            return { created: created.map((item) => item.key), status: "installed" };
        } catch (error) {
            await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation: begun.generation, installId: begun.installId });

            throw importFailure(error);
        }
    });
