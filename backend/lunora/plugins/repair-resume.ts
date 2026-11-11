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
import { assertSelectionImportable, BundleImportError, runBundleImport } from "../skills/bundle-plan";
import { planFor } from "../skills/bundle";
import { checkPluginFile } from "./install-action";
import { childOps } from "./install-ops";
import { repairRows } from "./repair";
import { vPluginItemKind } from "./validators";

export const beginRepair = internalMutation
    .input({ pluginSlug: v.string().max(64), userId: v.string().max(128) })
    .output(
        v.object({
            generation: v.number(),
            installId: v.string(),
            linked: v.number(),
            missing: v.array(v.object({ entryKey: v.string(), intentId: v.string(), kind: vPluginItemKind })),
            status: v.union(v.literal("installed"), v.literal("needs-repair")),
        }),
    )
    .mutation(async ({ args, ctx }) => await beginRepairRows(ctx, args.userId, args.pluginSlug));

export const beginRepairRows = async (
    ctx: MutationCtx,
    userId: string,
    pluginSlug: string,
): Promise<{
    generation: number;
    installId: string;
    linked: number;
    missing: Array<{ entryKey: string; intentId: string; kind: "group" | "skill" | "trigger" }>;
    status: "installed" | "needs-repair";
}> => {
    const result = await repairRows(ctx, userId, pluginSlug);
    const install = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    const installId = install._id as string;

    if (result.status === "installed") {
        return { generation: install.generation, installId, linked: result.linked, missing: [], status: "installed" };
    }

    // Takeover: the next generation, so an action started before this one writes nothing more.
    const generation = install.generation + 1;

    await ctx.db.patch("pluginInstalls", install._id as Id<"pluginInstalls">, { generation, updatedAt: ctx.now });

    const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });
    const missing = page
        .filter((row) => row.state === "intent" && result.missing.includes(row.entryKey))
        .map((row) => ({ entryKey: row.entryKey, intentId: row._id as string, kind: row.kind }));

    return { generation, installId, linked: result.linked, missing, status: "needs-repair" };
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
        const { header, hash } = await checkPluginFile(args.markdown);

        if (header.slug !== args.pluginSlug || hash !== args.contentHash) {
            throw new LunoraError("BAD_REQUEST", "This is not the file the plugin was installed from. Preview it again to repair it.");
        }

        const { userId } = ctx.user;
        const begun = await ctx.runMutation(internal.plugins.repair_resume.beginRepair, { pluginSlug: args.pluginSlug, userId });

        if (begun.missing.length === 0) {
            return { created: [], status: begun.status };
        }

        const { entries } = await planFor(ctx, args.markdown, undefined);
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
            const created = await runBundleImport(entries, missingKeys, ops, { keepOnRateLimit: true });

            await ctx.runMutation(internal.plugins.install_steps.finishInstall, { generation: begun.generation, installId: begun.installId });

            return { created: created.map((item) => item.key), status: "installed" };
        } catch (error) {
            await ctx.runMutation(internal.plugins.install_steps.markNeedsRepair, { generation: begun.generation, installId: begun.installId });

            throw error instanceof BundleImportError ? new LunoraError("BAD_REQUEST", error.message) : error;
        }
    });
