/**
 * Applying an update, in three internal mutations the update action calls in order:
 *   1. `beginUpdate` takes the install's lease (status `updating`, a new generation);
 *   2. `updateSkillChild` rewrites one unedited skill in place, after setting the child's pending hash;
 *   3. `finishUpdate` returns the install to `installed` at the new version.
 *
 * Every step checks the generation, so a stale action writes nothing. A child whose live content is not the
 * installed content is refused inside the same mutation that would write it. The pending hash is cleared to "",
 * which means "none": the schema has no way to clear an optional field.
 */
import { LunoraError, v } from "lunorash/server";

import { assertCronExpression, assertCustomModelRunnable, cleanPromptField, deleteTriggerRows } from "../triggers/functions";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { patchRow } from "../lib/patch";
import { skillRowHash, triggerRowHash } from "./entry-hash";
import { skillVisibility } from "../skills/access";
import { invalidateSkillsCache } from "../skills/cache";
import { deleteSkillRows } from "../skills/functions";
import { ensureSlugUnique, validateSlug } from "../skills/validators";
import { heldInstall, heldInstallForShardWrite, patchInstallIf } from "./held-install";
import { LEASE_MS, markerFor } from "./logic";
import { refuseWhileErasing } from "./owner-shard";

/** The same bound uninstall uses when it looks for group chats that name a skill. */
const GROUP_SCAN_LIMIT = 300;

export const beginUpdate = internalMutation
    .input({ expectedGeneration: v.number(), installId: v.string().max(128), targetVersion: v.string().max(32), userId: v.string().max(128) })
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        await refuseWhileErasing(ctx, args.userId);

        const install = await ctx.db.pluginInstalls.findFirst({
            consistency: "primary",
            where: { _id: args.installId as Id<"pluginInstalls">, userId: args.userId },
        });

        if (!install) {
            throw new LunoraError("NOT_FOUND", "The plugin is not installed");
        }

        if (install.status !== "installed") {
            throw new LunoraError("CONFLICT", `The plugin is ${install.status}, not installed`);
        }

        // The plan was made from the install as it was read: if another update finished since, the plan is stale and the caller must preview again.
        if (install.generation !== args.expectedGeneration) {
            throw new LunoraError("CONFLICT", "The plugin changed while this update was being prepared. Preview it again.");
        }

        const generation = install.generation + 1;

        // Conditional on the generation that was read: of two callers with the same plan, one takes the lease and the other is told to preview again.
        await patchInstallIf(
            ctx,
            args.installId as Id<"pluginInstalls">,
            install.generation,
            {
                generation,
                leaseUntil: ctx.now + LEASE_MS,
                status: "updating",
                targetVersion: args.targetVersion,
                updatedAt: ctx.now,
            },
            "The plugin changed while this update was being prepared. Preview it again.",
            "installed",
        );

        return generation;
    });

export const updateSkillChild = internalMutation
    .input({
        category: v.optional(v.string().max(128)),
        config: v.optional(v.any()),
        contentHash: v.string().max(128),
        description: v.string().max(4096),
        entryKey: v.string().max(256),
        generation: v.number(),
        icon: v.optional(v.string().max(2048)),
        installId: v.string().max(128),
        instructions: v.string().max(65_536),
        name: v.string().max(256),
        slug: v.string().max(256),
        tags: v.optional(v.array(v.string().max(256))),
        userId: v.string().max(128),
        variables: v.optional(v.any()),
        version: v.optional(v.string().max(64)),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        const link = page.find((row) => row.entryKey === args.entryKey && row.kind === "skill");

        if (!link || link.state !== "created") {
            throw new LunoraError("CONFLICT", `The child "${args.entryKey}" is not a linked skill of this plugin`);
        }

        const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(args.installId, args.entryKey) } });

        if (!skill || skill.userId !== args.userId) {
            throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" is missing`);
        }

        if ((await skillRowHash(skill)) !== link.contentHash) {
            throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" was edited, so it is kept as it is`);
        }

        // The planned slug gets the same checks skill creation gives it: a reserved or malformed slug is refused, and so is one another skill now holds.
        const slugValidation = validateSlug(args.slug);

        if (!slugValidation.valid) {
            throw new LunoraError("BAD_REQUEST", slugValidation.errors.join(", "));
        }

        await ensureSlugUnique(ctx, skill.userId, args.slug, skill._id);

        // Pending first: if the write below stops, repair sees a child that matches neither hash and knows an update was half done.
        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: args.contentHash });

        // The content a revision records: a change to it is a new version in the skill's history, as an edit by the owner would be.
        const contentChanged =
            args.instructions !== skill.instructions ||
            JSON.stringify(args.variables) !== JSON.stringify(skill.variables) ||
            JSON.stringify(args.config) !== JSON.stringify(skill.config);
        const currentVersion = (skill.currentVersion || 1) + (contentChanged ? 1 : 0);

        if (contentChanged) {
            await ctx.db.insert("skillHistory", {
                changeType: "plugin-update",
                config: args.config,
                createdAt: ctx.now,
                instructions: args.instructions,
                note: "Plugin update",
                skillId: skill._id,
                userId: skill.userId,
                variables: args.variables,
                version: currentVersion,
            });
        }

        // The slug is part of the content hash, so the row must take the planned slug or it reads as edited on the next update.
        // A field the new version leaves out is removed, so the row matches the hash recorded below.
        await patchRow(ctx.db, "skills", skill, {
            category: args.category,
            config: args.config,
            currentVersion,
            description: args.description,
            icon: args.icon,
            instructions: args.instructions,
            name: args.name,
            slug: args.slug,
            tags: args.tags,
            updatedAt: ctx.now,
            variables: args.variables,
            version: args.version,
        });

        await invalidateSkillsCache(ctx, skill.userId);

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: args.contentHash, pendingHash: "" });

        return null;
    });

export const finishUpdate = internalMutation
    .input({ contentHash: v.string().max(128), generation: v.number(), installId: v.string().max(128), version: v.string().max(32) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
            contentHash: args.contentHash,
            status: "installed",
            updatedAt: ctx.now,
            version: args.version,
        });

        return null;
    });

/** Whether the child a link names is still there, looked up by its marker. */
const childExists = async (ctx: Pick<MutationCtx, "db">, link: { entryKey: string; kind: string }, installId: string): Promise<boolean> => {
    const marker = markerFor(installId, link.entryKey);

    if (link.kind === "skill") {
        return (await ctx.db.skills.findFirst({ where: { pluginMarker: marker } })) !== null;
    }

    const table = link.kind === "trigger" ? "triggers" : "threads";
    const row = await ctx.db
        .query(table)
        .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
        .first();

    return row !== null;
};

/**
 * An update that stopped on an error. Every child step is one mutation, so each child is either at the old content or the new
 * one, and running the update again finishes what is left. Normally the install goes back to `installed` at its old version and
 * the intent rows of creations that were rolled back are removed. When rows could not be removed or a rate limit kept them
 * (`keepForRepair`), the install is `needs-repair` and holds the new file's hash, so repair accepts the new file to finish them.
 */
export const failUpdate = internalMutation
    .input({
        contentHash: v.string().max(128),
        /** The entry keys this update tried to create. A link among them whose child the rollback removed is dropped, so the next update creates it again. */
        createKeys: v.array(v.string().max(256)),
        generation: v.number(),
        installId: v.string().max(128),
        keepForRepair: v.boolean(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        if (args.keepForRepair) {
            await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
                contentHash: args.contentHash,
                status: "needs-repair",
                updatedAt: ctx.now,
            });

            return null;
        }

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });

        // Only the links of this attempt: its intents (an intent has no child yet) and the links of the children it created whose
        // rollback removed the child. The install is released afterwards, so no new update can record links while this runs.
        for (const row of page) {
            if (!args.createKeys.includes(row.entryKey)) {
                continue;
            }

            if (row.state === "intent" || (row.state === "created" && !(await childExists(ctx, row, args.installId)))) {
                await ctx.db.delete("pluginItems", row._id as Id<"pluginItems">);
            }
        }

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, { status: "installed", updatedAt: ctx.now });

        return null;
    });

/**
 * Rewrites one unedited schedule trigger in place. The trigger is switched off: a changed trigger must be read and re-enabled by
 * the person, so new content never runs unseen. Only schedule triggers are updated here; a webhook or an event trigger is
 * left as it is and the result is `false`, so the action reports it as skipped instead of stopping the update.
 */
export const updateTriggerChild = internalMutation
    .input({
        contentHash: v.string().max(128),
        cronExpression: v.optional(v.string().max(256)),
        description: v.optional(v.string().max(4096)),
        entryKey: v.string().max(256),
        generation: v.number(),
        inputTemplate: v.optional(v.string().max(65_536)),
        installId: v.string().max(128),
        model: v.string().max(256),
        name: v.string().max(256),
        searchMode: v.optional(v.string().max(256)),
        systemPrompt: v.optional(v.string().max(65_536)),
        timezone: v.optional(v.string().max(128)),
        userId: v.string().max(128),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });
        const link = page.find((row) => row.entryKey === args.entryKey && row.kind === "trigger");

        if (!link || link.state !== "created") {
            throw new LunoraError("CONFLICT", `The child "${args.entryKey}" is not a linked trigger of this plugin`);
        }

        const trigger = await ctx.db
            .query("triggers")
            .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(args.installId, args.entryKey)))
            .first();

        if (!trigger || trigger.userId !== args.userId) {
            throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" is missing`);
        }

        if (trigger.type !== "schedule") {
            return false;
        }

        if ((await triggerRowHash(trigger)) !== link.contentHash) {
            throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" was edited, so it is kept as it is`);
        }

        if (args.cronExpression !== undefined) {
            assertCronExpression(args.cronExpression);
        }

        // The same model check the create path makes: a custom model must be one the owner may run.
        await assertCustomModelRunnable(ctx, args.model, args.userId);

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: args.contentHash });

        // A field the new version leaves out is removed, so the row matches the hash recorded below.
        await patchRow(ctx.db, "triggers", trigger, {
            cronExpression: args.cronExpression,
            description: args.description,
            enabled: false,
            // Stored cleaned, the way trigger creation stores them, which is also what the entry hash is computed over.
            inputTemplate: cleanPromptField(args.inputTemplate, "The input"),
            model: args.model,
            name: args.name,
            searchMode: args.searchMode,
            systemPrompt: cleanPromptField(args.systemPrompt, "The system prompt"),
            timezone: args.timezone,
            updatedAt: ctx.now,
            // A changed schedule must not keep the due time of the old one: undefined removes it, and enabling recomputes it. An unchanged schedule keeps it.
            ...((args.cronExpression !== trigger.cronExpression || args.timezone !== trigger.timezone) && { nextTriggerAt: undefined }),
        });

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: args.contentHash, pendingHash: "" });

        return true;
    });

/** The child's link, by its entry key, after the generation check. */
const linkFor = async (ctx: Pick<MutationCtx, "db">, installId: string, entryKey: string) => {
    const { page } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId } });

    return page.find((row) => row.entryKey === entryKey);
};

/** A group chat of the owner that names the skill as a participant or synthesizer, if any. Too many conversations to scan counts as a user. */
const groupUsing = async (ctx: Pick<MutationCtx, "db">, skillId: string, userId: string): Promise<boolean> => {
    const threads = await ctx.db
        .query("threads")
        .withIndex("by_user_and_updatedAt", (q) => q.eq("userId", userId))
        .take(GROUP_SCAN_LIMIT);

    return (
        threads.length >= GROUP_SCAN_LIMIT ||
        threads.some(
            (thread) =>
                thread.groupChat?.synthesizerSkillId === skillId || thread.groupChat?.participants.some((participant) => participant.skillId === skillId),
        )
    );
};

/**
 * Removes an unedited child that the new version no longer has: its row, then its link. A child whose content is not what was
 * installed is refused here too, so the check does not depend on the diff having been current. A skill that a group chat still
 * names, or one shared beyond its owner, is kept (the result is `false`), so the group keeps its participant; the link stays and a later update offers the removal again.
 */
export const removeChild = internalMutation
    .input({ entryKey: v.string().max(256), generation: v.number(), installId: v.string().max(128), userId: v.string().max(128) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return true;
        }

        if (link.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(args.installId, args.entryKey) } });

            if (skill && skill.userId === args.userId) {
                if ((await skillRowHash(skill)) !== link.contentHash) {
                    throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" was edited, so it is kept`);
                }

                // A skill shared beyond its owner may sit in another person's group chat, on a shard this step cannot scan: keep it, detached.
                if (skillVisibility(skill) !== "private") {
                    await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
                    await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

                    return false;
                }

                if (await groupUsing(ctx, skill._id as string, args.userId)) {
                    return false;
                }

                await deleteSkillRows(ctx, skill._id as Id<"skills">, args.userId);
            }
        } else if (link.kind === "trigger") {
            const trigger = await ctx.db
                .query("triggers")
                .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", markerFor(args.installId, args.entryKey)))
                .first();

            if (trigger && trigger.userId === args.userId) {
                if ((await triggerRowHash(trigger)) !== link.contentHash) {
                    throw new LunoraError("CONFLICT", `The trigger for "${args.entryKey}" was edited, so it is kept`);
                }

                await deleteTriggerRows(ctx, trigger._id as Id<"triggers">);
            }
        } else {
            throw new LunoraError("CONFLICT", `"${args.entryKey}" is a group chat, which is not removed in place`);
        }

        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

        return true;
    });

/**
 * Keeps an edited child that the new version no longer has: its marker fields are cleared, so no later sweep finds it, and a
 * trigger is switched off. The link is deleted, so the child is no longer counted as part of the plugin.
 */
export const detachChild = internalMutation
    .input({ entryKey: v.string().max(256), generation: v.number(), installId: v.string().max(128), userId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return null;
        }

        const marker = markerFor(args.installId, args.entryKey);

        if (link.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: marker } });

            if (skill && skill.userId === args.userId) {
                await ctx.db.patch("skills", skill._id as Id<"skills">, { pluginInstallId: "", pluginMarker: "" });
            }
        } else if (link.kind === "trigger") {
            const trigger = await ctx.db
                .query("triggers")
                .withIndex("by_plugin_marker", (q) => q.eq("pluginMarker", marker))
                .first();

            if (trigger && trigger.userId === args.userId) {
                await ctx.db.patch("triggers", trigger._id as Id<"triggers">, { enabled: false, pluginInstallId: "", pluginMarker: "" });
            }
        } else {
            throw new LunoraError("CONFLICT", `"${args.entryKey}" is a group chat, which is not detached in place`);
        }

        // The link goes with the marker: a detached child is no longer part of the plugin, so a later version that brings the key back creates it afresh.
        await ctx.db.delete("pluginItems", link._id as Id<"pluginItems">);

        return null;
    });
