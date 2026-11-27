/**
 * Repair: finishes an install whose last run stopped part-way. An install is repairable when it is `needs-repair`, or
 * `installing` with an expired lease (its action died before it could say so). Each child that still has an intent row is
 * looked up by its marker. A child that exists is linked (its row becomes `created`). A row marked `created` whose child is
 * gone is put back to `intent`, so the resume path creates it again. A child with an unresolved pending hash (an update that
 * stopped on it) keeps the install in `needs-repair`. When every child is linked and settled the install returns to
 * `installed`; otherwise it stays `needs-repair`, and the missing entries are named.
 *
 * Creating a child that never existed is not done here: that is the resume path (`repair-resume.ts`).
 */
import { LunoraError } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { liveHashOf } from "./live-hash";
import { requireOwnerShard } from "./owner-shard";
import { patchRow } from "../lib/patch";
import { patchInstallIf, STALE } from "./held-install";
import { markerFor } from "./logic";
import type { ChildKind } from "./logic";

/** The id of the child that carries a marker, if it exists and belongs to the owner. */
export const childIdByMarker = async (ctx: MutationCtx, kind: ChildKind, marker: string, userId: string): Promise<string | undefined> => {
    if (kind === "skill") {
        const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: marker } });

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
    /** Children an update dropped that stay as the person's own, with the plugin's marker removed. */
    kept: string[];
    linked: number;
    missing: string[];
    /** More dropped children remain than one call handles: call again before anything is created or the install finished. */
    moreDropped: boolean;
    status: "installed" | "needs-repair";
}

type Link = {
    _id: unknown;
    contentHash: string;
    entryKey: string;
    itemId?: string;
    kind: ChildKind;
    pendingHash?: string;
    state: "created" | "intent";
};

/**
 * Decides each link that has a pending hash from its child's live content: a live hash equal to the pending hash means the
 * write finished (recorded); equal to the installed hash means it never wrote (cleared). Anything else is unresolved.
 */
const resolvePending = async (ctx: MutationCtx, installId: string, links: Link[]): Promise<{ resolved: number; unresolved: string[] }> => {
    let resolved = 0;
    const unresolved: string[] = [];

    for (const link of links) {
        if (!link.pendingHash || link.state !== "created") {
            continue;
        }

        const live = await liveHashOf(ctx, installId, link);

        if (live === link.pendingHash) {
            await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: link.pendingHash, pendingHash: "" });
            resolved += 1;
        } else if (live === link.contentHash) {
            await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: "" });
            resolved += 1;
        } else {
            unresolved.push(link.entryKey);
        }
    }

    return { resolved, unresolved };
};

/**
 * An update that stopped part-way. Its children are settled the same way as in an interrupted install: a pending hash is
 * decided from the live content, a new child that exists is linked, and an intent whose child was never made is dropped
 * (an update that runs again makes it). The install returns to `installed` at its OLD version and file hash: whether every
 * step of the target file ran is not recorded, so the update is run again to finish, and it skips what is already done.
 * Repair never runs while the update's lease is live.
 */
const repairStoppedUpdate = async (ctx: MutationCtx, install: Doc<"pluginInstalls">): Promise<RepairResult> => {
    if (install.leaseUntil === undefined || install.leaseUntil > ctx.now) {
        throw new LunoraError("CONFLICT", "An update of this plugin is still running");
    }

    const installId = install._id as string;
    const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });
    const { resolved, unresolved } = await resolvePending(ctx, installId, page as Link[]);

    let linked = resolved;

    for (const row of page) {
        if (row.state !== "intent") {
            continue;
        }

        const childId = await childIdByMarker(ctx, row.kind, markerFor(installId, row.entryKey), install.userId);

        if (childId === undefined) {
            await ctx.db.delete("pluginItems", row._id as Id<"pluginItems">);
            continue;
        }

        await ctx.db.patch("pluginItems", row._id as Id<"pluginItems">, { itemId: childId, state: "created" });
        linked += 1;
    }

    const status = unresolved.length === 0 ? "installed" : "needs-repair";

    // One conditional write on the generation and status read at the start, so a concurrent claim is never overwritten (`STALE_LEASE`).
    // The file hash stays the old file's, so the version stays the old one: a later repair must not promote it to the target. The target
    // version is set equal to the version (it reads as none), since removing it would replace the whole row.
    await patchInstallIf(
        ctx,
        install._id as Id<"pluginInstalls">,
        install.generation,
        {
            generation: install.generation + 1,
            // Some child may hold the target's content while the version stays the old one: export must not call the install complete.
            partial: true,
            status,
            ...(install.targetVersion !== undefined && { targetVersion: install.version }),
            updatedAt: ctx.now,
        },
        STALE,
        install.status,
    );

    return { kept: [], linked, missing: unresolved, moreDropped: false, status };
};

/** Whether repair may start on this install now. An `installing` install is repairable only after its lease expired. */
export const repairableNow = (install: { leaseUntil?: number; status: string }, now: number): boolean =>
    install.status === "needs-repair" || (install.status === "installing" && (install.leaseUntil === undefined || install.leaseUntil <= now));

/**
 * Dropped children handled per call. Each costs about three global statements (the skill read, its patch, the link delete), and
 * a call that detached anything does nothing else (see `more` below), so five stay far inside the statement budget.
 */
export const DETACH_PER_CALL = 5;

/**
 * An update kept for repair holds the new file's hash, so a `created` link whose key the file no longer has is a child the
 * update meant to drop. It is detached as the update would (marker cleared, a trigger switched off, the child kept), and its
 * link goes. A dropped group chat is detached by nothing in place: its link goes only when its thread is gone or never made, and
 * stays while the thread exists, as update leaves it. At most {@link DETACH_PER_CALL} children are handled; `more` says some remain.
 */
const detachDropped = async (
    ctx: MutationCtx,
    installId: string,
    userId: string,
    rows: Link[],
    fileKeys: ReadonlySet<string>,
): Promise<{ kept: string[]; more: boolean }> => {
    const kept: string[] = [];
    let handled = 0;

    for (const row of rows) {
        if (fileKeys.has(row.entryKey)) {
            continue;
        }

        const marker = markerFor(installId, row.entryKey);

        if (row.kind === "group") {
            const thread = row.state === "created" ? await childIdByMarker(ctx, "group", marker, userId) : undefined;

            if (thread !== undefined) {
                continue;
            }
        }

        if (handled >= DETACH_PER_CALL) {
            return { kept, more: true };
        }

        handled += 1;

        if (row.state === "created" && row.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ consistency: "primary", where: { pluginMarker: marker } });

            if (skill && skill.userId === userId) {
                await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
                kept.push(row.entryKey);
            }
        } else if (row.state === "created" && row.kind === "trigger") {
            const trigger = await ctx.db
                .query("triggers")
                .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
                .first();

            if (trigger && trigger.userId === userId) {
                await ctx.db.patch("triggers", trigger._id as Id<"triggers">, { enabled: false, pluginInstallId: "", pluginMarker: "" });
                kept.push(row.entryKey);
            }
        }

        await ctx.db.delete("pluginItems", row._id as Id<"pluginItems">);
    }

    // A call that detached anything ends there: the link and intent work waits for the next call, so the two never share one
    // call's statement budget.
    return { kept, more: handled > 0 };
};

/** Links every intent row whose child exists, and returns the install to `installed` once nothing is missing. */
export const repairRows = async (ctx: MutationCtx, userId: string, pluginSlug: string, fileKeys?: ReadonlySet<string>): Promise<RepairResult> => {
    // Triggers and group chats live on the owner's shard; anywhere else every child would read as gone and be created again.
    requireOwnerShard(userId, "repair");

    const install = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    if (install.status === "updating") {
        return await repairStoppedUpdate(ctx, install);
    }

    if (!repairableNow(install, ctx.now)) {
        throw new LunoraError(
            "CONFLICT",
            install.status === "installing" ? `The plugin "${pluginSlug}" is still being installed` : `The plugin "${pluginSlug}" does not need repair`,
        );
    }

    const installId = install._id as string;
    const { page: allRows } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });

    // With the file's keys in hand, a link the file no longer has is a dropped child. A plain repair's file holds every key its links
    // came from, so it drops nothing; an update that kept its version is found the same way. The rest of repair sees only the file's keys.
    const dropped = fileKeys === undefined ? { kept: [], more: false } : await detachDropped(ctx, installId, userId, allRows as Link[], fileKeys);
    const { kept } = dropped;

    // More dropped children than one call handles: stop here, within the call's statement budget; the caller calls again.
    if (dropped.more) {
        return { kept, linked: 0, missing: [], moreDropped: true, status: "needs-repair" };
    }

    const page = fileKeys === undefined ? allRows : allRows.filter((row) => fileKeys.has(row.entryKey));

    let linked = 0;
    const missing: string[] = [];

    // A row marked `created` whose child is gone (a rollback removed it, or the person did) goes back to `intent`.
    for (const row of page) {
        if (row.state !== "created") {
            continue;
        }

        if ((await childIdByMarker(ctx, row.kind, markerFor(installId, row.entryKey), userId)) !== undefined) {
            continue;
        }

        await patchRow(ctx.db, "pluginItems", row, { itemId: undefined, pendingHash: undefined, state: "intent" });
        missing.push(row.entryKey);
    }

    const { unresolved } = await resolvePending(ctx, installId, page.filter((row) => !missing.includes(row.entryKey)) as Link[]);

    missing.push(...unresolved);

    for (const row of page) {
        if (row.state !== "intent") {
            continue;
        }

        const childId = await childIdByMarker(ctx, row.kind, markerFor(installId, row.entryKey), userId);

        if (childId === undefined) {
            if (!missing.includes(row.entryKey)) {
                missing.push(row.entryKey);
            }

            continue;
        }

        await ctx.db.patch("pluginItems", row._id as Id<"pluginItems">, { itemId: childId, state: "created" });
        linked += 1;
    }

    if (missing.length === 0) {
        // An update kept for repair holds its target version; finishing the repair makes it the installed one. The next generation
        // fences out the action that stopped: an installed row carries no lease, so its generation is all that refuses it.
        // One conditional write on the generation and status read at the start, so a concurrent uninstall's claim is never overwritten.
        // The target version is set equal to the version (it reads as none), since removing it would replace the whole row; the lease
        // stays, which an installed row ignores.
        const version = install.targetVersion ?? install.version;

        await patchInstallIf(
            ctx,
            install._id as Id<"pluginInstalls">,
            install.generation,
            {
                generation: install.generation + 1,
                // Every child now matches the file it finishes at (the missing ones made, the dropped ones detached).
                partial: false,
                status: "installed",
                ...(install.targetVersion !== undefined && { targetVersion: version }),
                updatedAt: ctx.now,
                version,
            },
            STALE,
            install.status,
        );

        return { kept, linked, missing, moreDropped: false, status: "installed" };
    }

    if (install.status === "installing") {
        await patchInstallIf(
            ctx,
            install._id as Id<"pluginInstalls">,
            install.generation,
            { generation: install.generation + 1, status: "needs-repair", updatedAt: ctx.now },
            STALE,
            install.status,
        );
    }

    return { kept, linked, missing, moreDropped: false, status: "needs-repair" };
};
