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
import { internalMutation, internalQuery } from "../_generated/server";
import { authAction } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { assertSelectionImportable, runBundleImport } from "../skills/bundle-plan";
import { planFor } from "../skills/bundle";
import { assertNoToolConfig, checkPluginFile } from "./install-action";
import { childOps, importFailure } from "./install-ops";
import { entryHash } from "./entry-hash";
import { refuseUnderKillSwitch } from "./gate";
import { heldInstall, patchInstallIf, STALE } from "./held-install";
import { pluginSkillsByKey } from "./live-hash";
import { LEASE_MS } from "./logic";
import { refuseWhileErasing, requireOwnerShard } from "./owner-shard";
import { childIdByMarker, repairableNow, repairRows } from "./repair";
import { vPluginItemKind } from "./validators";

const vEntry = v.object({ contentHash: v.string().max(128), entryKey: v.string().max(256), kind: vPluginItemKind });

export const beginRepair = internalMutation
    .input({
        contentHash: v.string().max(128),
        entries: v.optional(v.array(vEntry)),
        fileKeys: v.optional(v.array(v.string().max(256))),
        pluginSlug: v.string().max(64),
        userId: v.string().max(128),
    })
    .output(
        v.object({
            existing: v.array(v.object({ entryKey: v.string(), itemId: v.string() })),
            generation: v.number(),
            installId: v.string(),
            kept: v.array(v.string()),
            linked: v.number(),
            missing: v.array(v.object({ entryKey: v.string(), intentId: v.string(), kind: vPluginItemKind })),
            moreDropped: v.boolean(),
            outdated: v.boolean(),
            status: v.union(v.literal("installed"), v.literal("needs-repair")),
            unresolved: v.array(v.string()),
        }),
    )
    .mutation(
        async ({ args, ctx }) =>
            await beginRepairRows(
                ctx,
                args.userId,
                args.pluginSlug,
                args.contentHash,
                args.entries,
                args.fileKeys === undefined ? undefined : new Set(args.fileKeys),
            ),
    );

export const beginRepairRows = async (
    ctx: MutationCtx,
    userId: string,
    pluginSlug: string,
    contentHash: string,
    /** Every entry the file would create. One with no row yet (an install stopped before it was reached) gets an intent row. */
    entries: { contentHash: string; entryKey: string; kind: "group" | "skill" | "trigger" }[] = [],
    /** Every key the file holds. With it, an install kept from an update detaches the children the file dropped. */
    fileKeys?: ReadonlySet<string>,
): Promise<{
    existing: { entryKey: string; itemId: string }[];
    generation: number;
    installId: string;
    /** Children the update dropped, detached and kept as the person's own. */
    kept: string[];
    linked: number;
    missing: { entryKey: string; intentId: string; kind: "group" | "skill" | "trigger" }[];
    /** More dropped children remain: call again before creating anything or finishing. */
    moreDropped: boolean;
    /** A linked child holds other content than the file's entry: the finished install is partial until an update rewrites it. */
    outdated: boolean;
    status: "installed" | "needs-repair";
    /** Children whose pending hash is not settled yet: the install may not finish while any remains. */
    unresolved: string[];
}> => {
    requireOwnerShard(userId, "repair");
    await refuseWhileErasing(ctx, userId);

    const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug, userId } });

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
        const { page: existingRows } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });
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

    const result = await repairRows(
        ctx,
        userId,
        pluginSlug,
        fileKeys,
        fileKeys === undefined ? undefined : new Map(entries.map((entry) => [entry.entryKey, entry.contentHash] as const)),
    );
    const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });
    const existing = page.flatMap((row) =>
        row.state === "created" && row.kind === "skill" && row.itemId ? [{ entryKey: row.entryKey, itemId: row.itemId }] : [],
    );
    const missing = page
        .filter((row) => row.state === "intent" && result.missing.includes(row.entryKey))
        .map((row) => {
            return { entryKey: row.entryKey, intentId: row._id as string, kind: row.kind };
        });

    const unresolved = result.missing.filter((key) => missing.every((row) => row.entryKey !== key));
    // `repairRows` may have moved the generation and status on (an expired install it marked for repair), so the claim below
    // and the generation returned are read again here, in this same mutation.
    const current = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { _id: install._id } });

    if (!current) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    // A call that settles a stopped update creates nothing: its file was not checked against the install, so it may hold other
    // content than the stored hash. A child it turned back into an intent is made by the next call, with the install's own file.
    const settledUpdate = install.status === "updating";

    if (result.status === "installed" || missing.length === 0 || result.moreDropped || settledUpdate) {
        return {
            existing,
            generation: current.generation,
            installId,
            kept: result.kept,
            linked: result.linked,
            missing: [],
            moreDropped: result.moreDropped,
            outdated: result.outdated,
            status: result.status,
            unresolved: settledUpdate ? result.missing : unresolved,
        };
    }

    // Takeover: the next generation and a fresh lease, so an action started before this one writes nothing more and no other
    // repair or uninstall starts while this one creates children. The action ends it with `finishInstall` or `markNeedsRepair`.
    const generation = current.generation + 1;

    await patchInstallIf(
        ctx,
        install._id as Id<"pluginInstalls">,
        current.generation,
        { generation, leaseUntil: ctx.now + LEASE_MS, status: "installing", updatedAt: ctx.now },
        STALE,
        current.status,
    );

    return {
        existing,
        generation,
        installId,
        kept: result.kept,
        linked: result.linked,
        missing,
        moreDropped: false,
        outdated: result.outdated,
        status: "needs-repair",
        unresolved,
    };
};

/**
 * Ends a repair that created children: like `finishInstall`, but the install is `partial` when a linked child still holds other
 * content than the file's entry for it (`beginRepair` says so). Repair does not rewrite a child; an update of the same file does.
 */
export const finishRepair = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128), partial: v.boolean() })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const install = await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);
        const version = install.targetVersion ?? install.version;

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
            partial: args.partial,
            status: "installed",
            ...(install.targetVersion !== undefined && { targetVersion: version }),
            updatedAt: ctx.now,
            version,
        });

        return null;
    });

/**
 * The slugs the installed skills hold now, by entry key. The file is planned with them, so a skill that already holds its slug
 * hashes as the file's entry does, instead of reading as a changed one because the slug looks taken.
 */
export const loadOwnSlugs = internalQuery
    .input({ pluginSlug: v.string().max(64), userId: v.string().max(128) })
    .output(v.array(v.object({ entryKey: v.string(), slug: v.string() })))
    .query(async ({ args, ctx }) => {
        requireOwnerShard(args.userId, "repair");

        const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug: args.pluginSlug, userId: args.userId } });

        if (!install) {
            return [];
        }

        const installId = install._id as string;
        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });
        const slugs: { entryKey: string; slug: string }[] = [];

        const skills = await pluginSkillsByKey(ctx, installId);

        for (const link of page) {
            if (link.kind !== "skill" || link.state !== "created") {
                continue;
            }

            const skill = skills.get(link.entryKey);

            if (skill && skill.userId === args.userId) {
                slugs.push({ entryKey: link.entryKey, slug: skill.slug });
            }
        }

        return slugs;
    });

/** The id of the child that carries a marker, if it exists and belongs to the owner: what a create that threw may have left behind. */
export const childIdForMarker = internalMutation
    .input({ kind: vPluginItemKind, marker: v.string().max(256), userId: v.string().max(128) })
    .output(v.union(v.null(), v.string()))
    .mutation(async ({ args, ctx }) => (await childIdByMarker(ctx, args.kind, args.marker, args.userId)) ?? null);

/** A child repair is about to create is baselined on the plan that creates it, which may differ from the install's (a slug taken since). */
export const setIntentHash = internalMutation
    .input({ contentHash: v.string().max(128), generation: v.number(), installId: v.string().max(128), intentId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);
        await ctx.db.patch("pluginItems", args.intentId as Id<"pluginItems">, { contentHash: args.contentHash });

        return null;
    });

export const repairPlugin = authAction
    .input({
        contentHash: v.string().max(128),
        markdown: v.string().max(MAX_LENGTH.document),
        pluginSlug: v.string().max(64),
    })
    .output(
        v.object({
            created: v.array(v.string()),
            // Children an interrupted update meant to drop: now the person's own, no longer part of the plugin.
            kept: v.array(v.string()),
            status: v.union(v.literal("installed"), v.literal("needs-repair")),
        }),
    )
    .action(async ({ args, ctx }) => {
        if (ctx.user.activeOrganization) {
            throw new LunoraError("UNPROCESSABLE", "Organization plugin installs are not available yet");
        }

        refuseUnderKillSwitch();

        const { hash, header } = await checkPluginFile(args.markdown);

        if (header.slug !== args.pluginSlug || hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "This is not the file the plugin was installed from. Preview it again to repair it.");
        }

        const { userId } = ctx.user;
        const ownSlugs = await ctx.runQuery(internal.plugins.repair_resume.loadOwnSlugs, { pluginSlug: args.pluginSlug, userId });
        const { entries } = await planFor(ctx, args.markdown, undefined, { ownSlugs });

        assertNoToolConfig(entries);

        // Every entry of the file, plannable or not: one that cannot be planned now (its model is gone) still gets an intent row, so
        // repair cannot finish without it. Its hash is the hash of nothing.
        const planned = await Promise.all(
            entries.map(async (entry) => {
                return { contentHash: await entryHash(entry), entryKey: entry.key, kind: entry.kind };
            }),
        );
        const begin = async () =>
            await ctx.runMutation(internal.plugins.repair_resume.beginRepair, {
                contentHash: hash,
                entries: planned,
                fileKeys: entries.map((entry) => entry.key),
                pluginSlug: args.pluginSlug,
                userId,
            });
        let begun = await begin();
        const kept = [...begun.kept];

        // Dropped children are detached a few per call (a mutation has a statement budget); nothing is created or finished until none remain.
        while (begun.moreDropped) {
            begun = await begin();
            kept.push(...begun.kept);
        }

        if (begun.missing.length === 0) {
            return { created: [], kept, status: begun.status };
        }

        const missingKeys = new Set(begun.missing.map((entry) => entry.entryKey));
        const intentByKey = new Map(begun.missing.map((entry) => [entry.entryKey, entry.intentId] as const));
        const hashByKey = new Map(planned.map((entry) => [entry.entryKey, entry.contentHash] as const));

        try {
            assertSelectionImportable(entries, missingKeys);
        } catch (error) {
            // An entry that cannot be planned now stays an intent: the install is left for repair, not held under this lease.
            await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation: begun.generation, installId: begun.installId });

            throw error;
        }

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

                await ctx.runMutation(internal.plugins.repair_resume.setIntentHash, {
                    contentHash: hashByKey.get(key) ?? "",
                    generation: begun.generation,
                    installId: begun.installId,
                    intentId,
                });

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

            // A child whose pending hash is still unresolved keeps the install in needs-repair, with its target version unchanged.
            if (begun.unresolved.length > 0) {
                await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation: begun.generation, installId: begun.installId });

                return { created: created.map((item) => item.key), kept, status: "needs-repair" };
            }

            await ctx.runMutation(internal.plugins.repair_resume.finishRepair, {
                generation: begun.generation,
                installId: begun.installId,
                partial: begun.outdated,
            });

            return { created: created.map((item) => item.key), kept, status: "installed" };
        } catch (error) {
            // Guarded: a lease that expired meanwhile makes this throw too, and the import's own error (and its retry hint) is the one to show.
            await ctx
                .runMutation(internal.plugins.install_steps.markNeedsRepair, { generation: begun.generation, installId: begun.installId })
                .catch(() => undefined);

            throw importFailure(error);
        }
    });
