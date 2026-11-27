/**
 * The permission mode a new chat of an owner starts with, read from `userSettings.defaultPermissionMode`. The rule itself is
 * `newChatPermissionMode` (`thread-permission-mode.ts`); this reads the owner's setting and who is asking for the chat.
 */
import { callerSessionNotOwn } from "../../auth/lib/caller-session";
import { requestSignInIsGrant } from "../../auth/lib/request-sign-in";
import type { MutationCtx } from "../../_generated/server";
import type { ThreadPermissionMode } from "./thread-permission-mode";
import { newChatPermissionMode } from "./thread-permission-mode";

type CallerCtx = MutationCtx & { user: { impersonatedBy?: string | null; userId: string } };

/**
 * Whether a new chat the caller starts may not take the owner's `full` default: an admin acting as the owner, a session that is
 * not verifiably the owner's own (an impersonation that has ended with its token still valid, an expired or missing session; see
 * `callerSessionMarks`), or a session that came through a grant (a browser extension relays page text into a chat, which `full`
 * would run unasked).
 */
export const callerRestrictsFull = async (ctx: CallerCtx): Promise<boolean> =>
    Boolean(ctx.user.impersonatedBy) || (await callerSessionNotOwn(ctx)) || requestSignInIsGrant(await ctx.auth.getIdentity());

/**
 * The mode to store on a new chat of `userId`, or `undefined` to store nothing (the defaults). Read in the caller's transaction.
 * `restrictsFull` is asked only when the owner's default is `full`: the restriction changes nothing else, so no other chat pays for
 * the session read.
 */
export const ownerNewChatMode = async (
    ctx: Pick<MutationCtx, "db">,
    userId: string,
    restrictsFull: () => Promise<boolean>,
): Promise<ThreadPermissionMode | undefined> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

    const defaultMode = settings?.defaultPermissionMode;

    return newChatPermissionMode(defaultMode, defaultMode === "full" ? await restrictsFull() : false);
};
