/**
 * The database steps of an install, each one a small internal mutation the install action calls in order:
 * create the install row, record each child's intent and then its link, and finish or fail the install.
 * Every step after the first checks the install's generation, so an action whose lease was taken over stops
 * and writes nothing more (`STALE_LEASE`).
 */
import { v, LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { LEASE_MS } from "./logic";
import { vPluginItemKind } from "./validators";

const STALE = "STALE_LEASE: this install was taken over by another action";

/** The install row, if it still exists, after checking that the caller still holds the lease it started under. */
const heldInstall = async (ctx: Pick<MutationCtx, "db">, installId: Id<"pluginInstalls">, generation: number) => {
    const install = await ctx.db.pluginInstalls.findFirst({ where: { _id: installId } });

    if (!install || install.generation !== generation) {
        throw new LunoraError("CONFLICT", STALE);
    }

    return install;
};

export const createInstallRow = internalMutation
    .input({
        contentHash: v.string().max(128),
        pluginSlug: v.string().max(64),
        userId: v.string().max(128),
        version: v.string().max(32),
    })
    .output(v.object({ generation: v.number(), installId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        const existing = await ctx.db.pluginInstalls.findFirst({ where: { pluginSlug: args.pluginSlug, userId: args.userId } });

        if (existing) {
            throw new LunoraError("CONFLICT", `The plugin "${args.pluginSlug}" is already installed. Uninstall it first.`);
        }

        const now = ctx.now;
        const installId = await ctx.db.insert("pluginInstalls", {
            contentHash: args.contentHash,
            generation: 1,
            installedAt: now,
            leaseUntil: now + LEASE_MS,
            pluginSlug: args.pluginSlug,
            status: "installing",
            updatedAt: now,
            userId: args.userId,
            version: args.version,
        });

        return { generation: 1, installId: installId as string };
    });

export const recordIntent = internalMutation
    .input({
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        kind: vPluginItemKind,
        userId: v.string().max(128),
    })
    .output(v.string())
    .mutation(async ({ args, ctx }) => {
        const install = await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const itemId = await ctx.db.insert("pluginItems", {
            contentHash: install.contentHash,
            createdAt: ctx.now,
            entryKey: args.entryKey,
            installId: args.installId,
            kind: args.kind,
            state: "intent",
            userId: args.userId,
        });

        return itemId as string;
    });

export const recordCreated = internalMutation
    .input({
        generation: v.number(),
        installId: v.string().max(128),
        intentId: v.string().max(128),
        itemId: v.string().max(128),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await ctx.db.patch("pluginItems", args.intentId as Id<"pluginItems">, { itemId: args.itemId, state: "created" });

        return null;
    });

export const finishInstall = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await ctx.db.patch("pluginInstalls", args.installId as Id<"pluginInstalls">, { status: "installed", updatedAt: ctx.now });

        return null;
    });

/** A failed install with rows it could not remove keeps them: the row is `needs-repair` and names the resume point. */
export const markNeedsRepair = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await ctx.db.patch("pluginInstalls", args.installId as Id<"pluginInstalls">, { status: "needs-repair", updatedAt: ctx.now });

        return null;
    });

/** A clean rollback: the install and its links go, once every child is gone. */
export const deleteInstall = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const links = await ctx.db.pluginItems.findMany({ where: { installId: args.installId } });

        for (const link of links.page) {
            await ctx.db.delete("pluginItems", link._id);
        }

        await ctx.db.delete("pluginInstalls", args.installId as Id<"pluginInstalls">);

        return null;
    });
