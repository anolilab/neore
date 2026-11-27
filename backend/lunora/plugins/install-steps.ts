/**
 * The database steps of an install, each one a small internal mutation the install action calls in order:
 * create the install row, record each child's intent and then its link, and finish or fail the install.
 * Every step after the first checks the install's generation, so an action whose lease was taken over stops
 * and writes nothing more (`STALE_LEASE`).
 */
import { v, LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { heldInstall, heldInstallForShardWrite, patchInstallIf } from "./held-install";
import { refuseWhileErasing, requireOwnerShard } from "./owner-shard";
import { LEASE_MS } from "./logic";
import { vPluginItemKind } from "./validators";

export const createInstallRow = internalMutation
    .input({
        contentHash: v.string().max(128),
        pluginSlug: v.string().max(64),
        userId: v.string().max(128),
        version: v.string().max(32),
    })
    .output(v.object({ generation: v.number(), installId: v.string() }))
    .mutation(async ({ args, ctx }) => {
        requireOwnerShard(args.userId, "install");
        await refuseWhileErasing(ctx, args.userId);

        const existing = await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { pluginSlug: args.pluginSlug, userId: args.userId } });

        if (existing) {
            throw new LunoraError("CONFLICT", `The plugin "${args.pluginSlug}" is already installed. Uninstall it first.`);
        }

        const { now } = ctx;
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
        contentHash: v.string().max(128),
        entryKey: v.string().max(256),
        generation: v.number(),
        installId: v.string().max(128),
        kind: vPluginItemKind,
        userId: v.string().max(128),
    })
    .output(v.string())
    .mutation(async ({ args, ctx }) => {
        await refuseWhileErasing(ctx, args.userId);

        // Each create that follows writes a sharded table (skills, triggers, group chats) and needs time left on the lease.
        await heldInstallForShardWrite(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        const itemId = await ctx.db.insert("pluginItems", {
            contentHash: args.contentHash,
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
        const install = await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        // An update kept for repair holds its target version: finishing it makes that the installed version, to match the new file's hash.
        // The target version is not removed (a removal is a replace of the row, which cannot be conditional); it is set equal to the
        // version, so it reads the same as none (`targetVersion ?? version`) and the whole write stays one conditional patch.
        const version = install.targetVersion ?? install.version;

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, {
            status: "installed",
            ...(install.targetVersion !== undefined && { targetVersion: version }),
            updatedAt: ctx.now,
            version,
        });

        return null;
    });

/** A failed install with rows it could not remove keeps them: the row is `needs-repair` and names the resume point. */
export const markNeedsRepair = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        await patchInstallIf(ctx, args.installId as Id<"pluginInstalls">, args.generation, { status: "needs-repair", updatedAt: ctx.now });

        return null;
    });

/** A clean rollback: the install and its links go, once every child is gone. */
export const deleteInstall = internalMutation
    .input({ generation: v.number(), installId: v.string().max(128) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await heldInstall(ctx, args.installId as Id<"pluginInstalls">, args.generation);

        // Every link, not one page of them: a link left behind would name an install that no longer exists.
        for (;;) {
            const { page: links } = await ctx.db.pluginItems.findMany({ consistency: "primary", where: { installId: args.installId } });

            if (links.length === 0) {
                break;
            }

            for (const link of links) {
                await ctx.db.delete("pluginItems", link._id);
            }
        }

        await ctx.db.delete("pluginInstalls", args.installId as Id<"pluginInstalls">);

        return null;
    });
