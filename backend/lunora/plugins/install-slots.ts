/**
 * The slot row that makes "one install per person and plugin" a database fact: its unique index refuses a second install of the same
 * plugin. The slot lives as long as the install row and is deleted in the same call as it.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { isUniqueViolation } from "../lib/error-helpers";
import { LEASE_MS } from "./logic";

const alreadyInstalled = (pluginSlug: string) => new LunoraError("CONFLICT", `The plugin "${pluginSlug}" is already installed. Uninstall it first.`);

type SlotRow = { _id: Id<"pluginInstallSlots">; createdAt: number; installId?: string };

/** A slot nothing holds: it names no install row, or a create never finished it (no install id, older than the install lease). */
const isLeftover = async (ctx: MutationCtx, slot: SlotRow): Promise<boolean> => {
    if (slot.installId === undefined) {
        return slot.createdAt + LEASE_MS < ctx.now;
    }

    return !(await ctx.db.pluginInstalls.findFirst({ consistency: "primary", where: { _id: slot.installId as Id<"pluginInstalls"> } }));
};

/**
 * Takes the slot for a new install and returns its id. A taken slot refuses with the "already installed" CONFLICT, unless it is a
 * leftover: one that names no install row, or one a create never finished (no install id, older than the install lease). A leftover
 * is deleted and the slot taken once more, so a crash between a create's two inserts never blocks a reinstall.
 */
export const claimInstallSlot = async (ctx: MutationCtx, userId: string, pluginSlug: string): Promise<Id<"pluginInstallSlots">> => {
    const insert = async () => await ctx.db.insert("pluginInstallSlots", { createdAt: ctx.now, pluginSlug, userId });

    try {
        return await insert();
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }

    const slot = await ctx.db.pluginInstallSlots.findFirst({ consistency: "primary", where: { pluginSlug, userId } });

    if (!slot) {
        // Released since the failed insert: a plain retry.
        return await insert();
    }

    if (!(await isLeftover(ctx, slot))) {
        throw alreadyInstalled(pluginSlug);
    }

    await ctx.db.delete("pluginInstallSlots", slot._id);

    try {
        return await insert();
    } catch (error) {
        if (isUniqueViolation(error)) {
            throw alreadyInstalled(pluginSlug);
        }

        throw error;
    }
};

/** Deletes the slot held for one install, if there is one. */
export const releaseInstallSlot = async (ctx: MutationCtx, installId: string): Promise<void> => {
    const slot = await ctx.db.pluginInstallSlots.findFirst({ consistency: "primary", where: { installId } });

    if (slot) {
        await ctx.db.delete("pluginInstallSlots", slot._id);
    }
};

/** Deletes a slot by id when it is still there (the install insert failed). */
export const releaseSlotById = async (ctx: MutationCtx, slotId: Id<"pluginInstallSlots">): Promise<void> => {
    const slot = await ctx.db.pluginInstallSlots.findFirst({ consistency: "primary", where: { _id: slotId } });

    if (slot) {
        await ctx.db.delete("pluginInstallSlots", slot._id);
    }
};

/**
 * Moves the slot held for an install to another person. False when that person already holds a slot for the plugin (a live one:
 * the caller drops the install instead); a leftover slot of theirs is deleted and the move retried. No slot is a move done.
 */
export const moveInstallSlot = async (ctx: MutationCtx, installId: string, to: string): Promise<boolean> => {
    const slot = await ctx.db.pluginInstallSlots.findFirst({ consistency: "primary", where: { installId } });

    if (!slot || slot.userId === to) {
        return true;
    }

    try {
        await ctx.db.patch("pluginInstallSlots", slot._id, { userId: to });

        return true;
    } catch (error) {
        if (!isUniqueViolation(error)) {
            throw error;
        }
    }

    const theirs = await ctx.db.pluginInstallSlots.findFirst({ consistency: "primary", where: { pluginSlug: slot.pluginSlug, userId: to } });

    if (!theirs || !(await isLeftover(ctx, theirs))) {
        return false;
    }

    await ctx.db.delete("pluginInstallSlots", theirs._id);
    await ctx.db.patch("pluginInstallSlots", slot._id, { userId: to });

    return true;
};
