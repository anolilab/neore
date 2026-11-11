/**
 * Uninstall: removes a plugin's children and its install.
 *
 * Order: refuse first (a group chat that uses a skill of this plugin, or a scan that hits its bound), then take the lease,
 * then sweep. An unedited skill is deleted with its rows. An edited skill is kept: its marker fields are cleared, so the
 * sweep no longer finds it. A trigger, or a group chat created by the plugin, is kept and detached as well, because its
 * installed content cannot be compared with its live content yet. Then the links and the install go.
 *
 * Cleared fields are "" rather than absent: the schema cannot clear an optional field with a patch.
 */
import { LunoraError, v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { authMutation } from "../lib/crpc";
import { deleteSkillRows } from "../skills/functions";
import { skillRowHash } from "./entry-hash";
import { LEASE_MS, parseMarker } from "./logic";

/** How many of the owner's threads the group check reads. A scan that reaches it cannot prove a group is clear, so it refuses. */
const GROUP_SCAN_LIMIT = 300;

export interface UninstallResult {
    kept: string[];
    removed: number;
}

export const uninstallRows = async (ctx: MutationCtx, userId: string, pluginSlug: string): Promise<UninstallResult> => {
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

        const user = threads.find((thread) => thread.groupChat?.participants.some((participant) => skillIds.has(participant.skillId)));

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

    for (const link of links) {
        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);
    }

    await ctx.db.delete("pluginInstalls", install._id as Id<"pluginInstalls">);

    return { kept, removed };
};

export const uninstallPlugin = authMutation
    .input({ pluginSlug: v.string().max(64) })
    .output(v.object({ kept: v.array(v.string()), removed: v.number() }))
    .mutation(async ({ args, ctx }) => await uninstallRows(ctx, ctx.user.userId, args.pluginSlug));
