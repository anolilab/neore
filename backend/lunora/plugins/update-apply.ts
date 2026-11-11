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

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { withoutUndefined } from "../lib/patch";
import { skillRowHash } from "./entry-hash";
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
