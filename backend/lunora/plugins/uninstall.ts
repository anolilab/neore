/**
 * Uninstall: removes a plugin's children and its install, in three steps.
 *
 *   1. `uninstallRows` (begin): refuses first, then takes the lease and sweeps. A group chat with messages refuses the whole
 *      uninstall, and so does a group chat of someone else that uses a skill of this plugin. An unedited skill is deleted with
 *      its rows. An edited skill is kept with its marker cleared. A trigger is kept and switched off. The plugin's own empty group
 *      chats are returned for deletion.
 *   2. The action deletes those empty group chats, in pages (`deleteAllForThreadIdAsync`, which is only callable from an action).
 *   3. `finishUninstallRows` removes the links and the install, once every child that was going to go has gone.
 *
 * Cleared fields are "" rather than absent: the schema cannot clear an optional field with a patch.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { skillRowHash } from "./entry-hash";
import { LEASE_MS, parseMarker } from "./logic";
import { deleteSkillRows } from "../skills/functions";

/** How many of the owner's threads a scan reads. A scan that reaches it cannot prove a group is clear, so it refuses. */
const GROUP_SCAN_LIMIT = 300;

export interface UninstallBegun {
    generation: number;
    groups: string[];
    installId: string;
    kept: string[];
    removed: number;
}

export const uninstallRows = async (ctx: MutationCtx, userId: string, pluginSlug: string): Promise<UninstallBegun> => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug, userId } });

    if (!install) {
        throw new LunoraError("NOT_FOUND", `The plugin "${pluginSlug}" is not installed`);
    }

    if (["installing", "updating", "uninstalling"].includes(install.status) && install.leaseUntil !== undefined && install.leaseUntil > ctx.now) {
        throw new LunoraError("CONFLICT", `The plugin "${pluginSlug}" is busy. Try again in a few minutes.`);
    }

    const installId = install._id as string;
    const { page: links } = await ctx.db.pluginItems.findMany({ where: { installId } });
    const { page: skills } = await ctx.db.skills.findMany({ where: { pluginInstallId: installId } });
    const skillIds = new Set(skills.map((skill) => skill._id as string));

    // The plugin's own group chats: any with messages refuses the uninstall; the empty ones go with it.
    const ownGroups = await ctx.db
        .query("threads")
        .withIndex("by_plugin_install", (q) => q.eq("pluginInstallId", installId))
        .take(GROUP_SCAN_LIMIT);

    if (ownGroups.length >= GROUP_SCAN_LIMIT) {
        throw new LunoraError("CONFLICT", "This plugin has too many group chats to remove in one step. Delete some of them first.");
    }

    const groups: string[] = [];

    for (const group of ownGroups) {
        const message = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", group._id as Id<"threads">))
            .first();

        if (message) {
            throw new LunoraError("CONFLICT", `"${group.title ?? "A group chat"}" has messages. Delete it yourself first, then uninstall the plugin.`);
        }

        groups.push(group._id as string);
    }

    if (skillIds.size > 0) {
        const threads = await ctx.db
            .query("threads")
            .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
            .take(GROUP_SCAN_LIMIT);

        if (threads.length >= GROUP_SCAN_LIMIT) {
            throw new LunoraError(
                "CONFLICT",
                "Too many conversations to check that no group chat uses this plugin. Remove the plugin later, or change the group chats first.",
            );
        }

        // The plugin's own groups use its skills by design; only someone else's group blocks.
        const user = threads.find(
            (thread) => thread.pluginInstallId !== installId && thread.groupChat?.participants.some((participant) => skillIds.has(participant.skillId)),
        );

        if (user) {
            throw new LunoraError("CONFLICT", `"${user.title ?? "A group chat"}" uses a skill of this plugin. Change that group chat first.`);
        }
    }

    const generation = install.generation + 1;

    await ctx.db.patch("pluginInstalls", install._id as Id<"pluginInstalls">, {
        generation,
        leaseUntil: ctx.now + LEASE_MS,
        status: "uninstalling",
        updatedAt: ctx.now,
    });

    let removed = 0;
    const kept: string[] = [];

    for (const skill of skills) {
        const marker = parseMarker(skill.pluginMarker ?? "");
        const link = links.find((row) => row.entryKey === marker?.entryKey);
        const edited = !link || (await skillRowHash(skill)) !== link.contentHash;

        if (edited) {
            await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
            kept.push(skill.name);
            continue;
        }

        await deleteSkillRows(ctx, skill._id as Id<"skills">, userId);
        removed += 1;
    }

    const triggers = await ctx.db
        .query("triggers")
        .withIndex("by_plugin_install", (q) => q.eq("pluginInstallId", installId))
        .collect();

    for (const trigger of triggers) {
        // Disabled as well: a kept trigger must not run after its plugin is gone.
        await ctx.db.patch("triggers", trigger._id as Id<"triggers">, { enabled: false, pluginInstallId: "", pluginMarker: "" });
        kept.push(trigger.name);
    }

    return { generation, groups, installId, kept, removed };
};

/**
 * Run right before a group chat is deleted. The begin step checked it was empty, but that check and the delete are separate
 * transactions, so a message may have landed in between. Throwing here would strand a half-uninstalled plugin (skills swept,
 * lease held, begin refuses retries), so a group that now has messages is detached and kept instead.
 *
 * Returns `true` when the group may be deleted, `false` when it was kept.
 */
export const claimGroupForDelete = async (ctx: MutationCtx, installId: string, generation: number, threadId: string): Promise<boolean> => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId as Id<"pluginInstalls"> } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", "STALE_LEASE: this uninstall was taken over by another action");
    }

    const thread = await ctx.db.get("threads", threadId as Id<"threads">);

    if (!thread || thread.pluginInstallId !== installId) {
        return false;
    }

    const message = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", threadId as Id<"threads">))
        .first();

    if (message) {
        await ctx.db.patch("threads", threadId as Id<"threads">, { pluginInstallId: "", pluginMarker: "" });

        return false;
    }

    return true;
};

/** The last step: the links and the install go. Called once the group chats have been deleted. */
export const finishUninstallRows = async (ctx: MutationCtx, installId: string, generation: number): Promise<void> => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId as Id<"pluginInstalls"> } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", "STALE_LEASE: this uninstall was taken over by another action");
    }

    const { page: links } = await ctx.db.pluginItems.findMany({ where: { installId } });

    for (const link of links) {
        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);
    }

    await ctx.db.delete("pluginInstalls", install._id as Id<"pluginInstalls">);
};
