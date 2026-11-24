/**
 * The permission mode a new chat of an owner starts with, read from `userSettings.defaultPermissionMode`. The rule itself is
 * `newChatPermissionMode` (`thread-permission-mode.ts`); this only reads the owner's setting.
 */
import type { MutationCtx } from "../../_generated/server";
import type { ThreadPermissionMode } from "./thread-permission-mode";
import { newChatPermissionMode } from "./thread-permission-mode";

/** The mode to store on a new chat of `userId`, or `undefined` to store nothing (the defaults). Read in the caller's transaction. */
export const ownerNewChatMode = async (ctx: Pick<MutationCtx, "db">, userId: string, impersonated: boolean): Promise<ThreadPermissionMode | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return newChatPermissionMode(settings?.defaultPermissionMode, impersonated);
};
