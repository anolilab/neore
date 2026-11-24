/**
 * The permission mode a new chat of an owner starts with, read from `userSettings.defaultPermissionMode`. The rule itself is
 * `newChatPermissionMode` (`thread-permission-mode.ts`); this reads the owner's setting and who is asking for the chat.
 */
import { requestSignInIsGrant } from "../../auth/lib/request-sign-in";
import type { MutationCtx } from "../../_generated/server";
import type { ThreadPermissionMode } from "./thread-permission-mode";
import { newChatPermissionMode } from "./thread-permission-mode";

/**
 * Whether a new chat the caller starts may not take the owner's `full` default: an admin acting as the owner, or a session that came
 * through a grant (a browser extension relays page text into a chat, which `full` would run unasked).
 */
export const callerRestrictsFull = async (ctx: MutationCtx, user: { impersonatedBy?: string | null }): Promise<boolean> =>
    Boolean(user.impersonatedBy) || requestSignInIsGrant(await ctx.auth.getIdentity());

/** The mode to store on a new chat of `userId`, or `undefined` to store nothing (the defaults). Read in the caller's transaction. */
export const ownerNewChatMode = async (ctx: Pick<MutationCtx, "db">, userId: string, restrictsFull: boolean): Promise<ThreadPermissionMode | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    return newChatPermissionMode(settings?.defaultPermissionMode, restrictsFull);
};
