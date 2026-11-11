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

import { assertCronExpression, assertCustomModelRunnable, deleteTriggerRows } from "../triggers/functions";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { withoutUndefined } from "../lib/patch";
import { skillRowHash, triggerRowHash } from "./entry-hash";
import { deleteSkillRows } from "../skills/functions";
import { LEASE_MS, markerFor } from "./logic";

const STALE = "STALE_LEASE: this install was taken over by another action";

/** The install row, after checking that the caller still holds the lease it started under. */
const heldInstall = async (ctx: Pick<MutationCtx, "db">, installId: Id<"pluginInstalls">, generation: number) => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", STALE);
    }

    return install;
};

export const beginUpdate = internalMutation
    .input({ installId: v.string().max(128), targetVersion: v.string().max(32), userId: v.string().max(128) })
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: args.installId as Id<"pluginInstalls">, userId: args.userId } });

        if (!install) {
            throw new LunoraError("NOT_FOUND", "The plugin is not installed");
        }

        if (install.status !== "installed") {
            throw new LunoraError("CONFLICT", `The plugin is ${install.status}, not installed`);
        }

        const generation = install.generation + 1;

        await ctx.db.patch("pluginInstalls", args.installId as Id<"pluginInstalls">, {
            generation,
            leaseUntil: ctx.now + LEASE_MS,
            status: "updating",
            targetVersion: args.targetVersion,
            updatedAt: ctx.now,
        });

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
        instructions: v.string().max(65536),
        name: v.string().max(256),
        tags: v.optional(v.array(v.string().max(256))),
        variables: v.optional(v.any()),
        version: v.optional(v.string().max(64)),
        userId: v.string().max(128),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const { page } = await ctx.db.pluginItems.findMany({ where: { installId: args.installId } });
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

        // Pending first: if the write below stops, repair sees a child that matches neither hash and knows an update was half done.
        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { pendingHash: args.contentHash });

        await ctx.db.patch(
            "skills",
            skill._id as Id<"skills">,
            withoutUndefined({
                category: args.category,
                config: args.config,
                description: args.description,
                icon: args.icon,
                instructions: args.instructions,
                name: args.name,
                tags: args.tags,
                updatedAt: ctx.now,
                variables: args.variables,
                version: args.version,
            }),
        );

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: args.contentHash, pendingHash: "" });

        return null;
    });

export const finishUpdate = internalMutation
    .input({ contentHash: v.string().max(128), generation: v.number(), installId: v.string().max(128), version: v.string().max(32) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await ctx.db.patch("pluginInstalls", args.installId as Id<"pluginInstalls">, {
            contentHash: args.contentHash,
            status: "installed",
            updatedAt: ctx.now,
            version: args.version,
        });

        return null;
    });

/**
 * Rewrites one unedited schedule trigger in place. The trigger is switched off: a changed trigger must be read and re-enabled by
 * the person, so new content never runs unseen. Only schedule triggers are updated here; a webhook or an event trigger is
 * reported as skipped.
 *
 * A field the new version leaves out keeps its old value, so the trigger then reads as edited (the safe side).
 */
export const updateTriggerChild = internalMutation
    .input({
        contentHash: v.string().max(128),
        cronExpression: v.optional(v.string().max(256)),
        description: v.optional(v.string().max(4096)),
        entryKey: v.string().max(256),
        generation: v.number(),
        inputTemplate: v.optional(v.string().max(65536)),
        installId: v.string().max(128),
        model: v.string().max(256),
        name: v.string().max(256),
        searchMode: v.optional(v.string().max(256)),
        systemPrompt: v.optional(v.string().max(65536)),
        timezone: v.optional(v.string().max(128)),
        userId: v.string().max(128),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const { page } = await ctx.db.pluginItems.findMany({ where: { installId: args.installId } });
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
            throw new LunoraError("CONFLICT", `"${args.entryKey}" is not a schedule trigger, so it is not updated in place`);
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

        await ctx.db.patch(
            "triggers",
            trigger._id as Id<"triggers">,
            withoutUndefined({
                cronExpression: args.cronExpression,
                description: args.description,
                enabled: false,
                inputTemplate: args.inputTemplate,
                model: args.model,
                name: args.name,
                searchMode: args.searchMode,
                systemPrompt: args.systemPrompt,
                timezone: args.timezone,
                updatedAt: ctx.now,
            }),
        );

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { contentHash: args.contentHash, pendingHash: "" });

        return null;
    });

/** The child's link, by its entry key, after the generation check. */
const linkFor = async (ctx: Pick<MutationCtx, "db">, installId: string, entryKey: string) => {
    const { page } = await ctx.db.pluginItems.findMany({ where: { installId } });

    return page.find((row) => row.entryKey === entryKey);
};

/**
 * Removes an unedited child that the new version no longer has: its row, then its link. A child whose content is not what was
 * installed is refused here too, so the check does not depend on the diff having been current.
 */
export const removeChild = internalMutation
    .input({ entryKey: v.string().max(256), generation: v.number(), installId: v.string().max(128), userId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const link = await linkFor(ctx, args.installId, args.entryKey);

        if (!link) {
            return null;
        }

        if (link.kind === "skill") {
            const skill = await ctx.db.skills.findFirst({ where: { pluginMarker: markerFor(args.installId, args.entryKey) } });

            if (skill && skill.userId === args.userId) {
                if ((await skillRowHash(skill)) !== link.contentHash) {
                    throw new LunoraError("CONFLICT", `The skill for "${args.entryKey}" was edited, so it is kept`);
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

        return null;
    });

/**
 * Keeps an edited child that the new version no longer has: its marker fields are cleared, so no later sweep finds it, and a
 * trigger is switched off. The link is marked detached.
 */
export const detachChild = internalMutation
    .input({ entryKey: v.string().max(256), generation: v.number(), installId: v.string().max(128), userId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

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

        await ctx.db.patch("pluginItems", link._id as Id<"pluginItems">, { state: "detached" });

        return null;
    });
