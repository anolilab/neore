/**
 * Repair: finishes an install whose last run stopped part-way. For each child that still has an intent row, the child is
 * looked up by its marker. A child that exists is linked (its row becomes `created`). When every child is linked the
 * install returns to `installed`; otherwise it stays `needs-repair`, and the missing entries are named.
 *
 * Creating a child that never existed is not done here: that needs the resume path, which is not built yet.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { skillRowHash } from "./entry-hash";
import { markerFor } from "./logic";
import type { ChildKind } from "./logic";

/** The id of the child that carries a marker, if it exists and belongs to the owner. */
const childIdByMarker = async (ctx: MutationCtx, kind: ChildKind, marker: string, userId: string): Promise<string | undefined> => {
    if (kind === "skill") {
        const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: marker } });

        return skill && skill.userId === userId ? (skill._id as string) : undefined;
    }

    const table = kind === "trigger" ? "triggers" : "threads";
    const row = await ctx.db
        .query(table)
        .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
        .first();

    return row && row.userId === userId ? (row._id as string) : undefined;
};

export interface RepairResult {
    linked: number;
    missing: string[];
    status: "installed" | "needs-repair";
}

/**
 * An update that stopped part-way. Each child that had a pending hash is decided from its live content: a live hash equal
 * to the pending hash means its write finished (recorded); equal to the installed hash means it never wrote (cleared).
 * Anything else is unresolved and the install stays `needs-repair`. Repair never runs while the update's lease is live.
 */
const repairStoppedUpdate = async (
    ctx: MutationCtx,
    install: { _id: Id<"pluginInstalls">; generation: number; leaseUntil?: number; status: string; targetVersion?: string; version: string },
): Promise<RepairResult> => {
    if (install.leaseUntil === undefined || install.leaseUntil > ctx.now) {
        throw new LunoraError("CONFLICT", "An update of this plugin is still running");
    }

    const installId = install._id as string;
    const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });

    let linked = 0;
    const missing: string[] = [];

    for (const link of page) {
        if (!link.pendingHash) {
            continue;
        }

        const skill = link.kind === "skill" ? await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(installId, link.entryKey) } }) : null;
        const live = skill ? await skillRowHash(skill) : undefined;

        if (live === link.pendingHash) {
            await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: link.pendingHash, pendingHash: "" });
            linked += 1;
        } else if (live === link.contentHash) {
            await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: "" });
            linked += 1;
        } else {
            missing.push(link.entryKey);
        }
    }

    const status = missing.length === 0 ? "installed" : "needs-repair";

    await ctx.db.patch("pluginInstalls", install._id, {
        generation: install.generation + 1,
        status,
        updatedAt: ctx.now,
        version: missing.length === 0 ? (install.targetVersion ?? install.version) : install.version,
    });

    return { linked, missing, status };
};

/** Links every intent row whose child exists, and returns the install to `installed` once nothing is missing. */
export const repairRows = async (ctx: MutationCtx, userId: string, pluginSlug: string): Promise<RepairResult> => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    if (install.status === "updating") {
        return await repairStoppedUpdate(ctx, install);
    }

    if (install.status !== "needs-repair") {
        throw new LunoraError("CONFLICT", `The plugin "${pluginSlug}" does not need repair`);
    }

    const installId = install._id as string;
    const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });
    const intents = page.filter((row) => row.state === "intent");

    let linked = 0;
    const missing: string[] = [];

    for (const row of intents) {
        const childId = await childIdByMarker(ctx, row.kind, markerFor(installId, row.entryKey), userId);

        if (childId === undefined) {
            missing.push(row.entryKey);
            continue;
        }

        await ctx.db.patch("pluginItems", row._id as Id<"pluginItems">, { itemId: childId, state: "created" });
        linked += 1;
    }

    if (missing.length === 0) {
        await ctx.db.patch("pluginInstalls", install._id as Id<"pluginInstalls">, { status: "installed", updatedAt: ctx.now });

        return { linked, missing, status: "installed" };
    }

    return { linked, missing, status: "needs-repair" };
};
