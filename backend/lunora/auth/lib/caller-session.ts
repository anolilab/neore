import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { requestSignIn } from "./request-sign-in";

/**
 * Whether what a cRPC caller sends or answers may NOT count as the owner's own: an admin acting as them, or a sign-in
 * whose session row cannot be read as theirs (none named, gone, another user's or expired, as an ended impersonation
 * whose token has not yet expired). An approval, question or secret answered so marks its continuation impersonated
 * (`claimToolApproval`'s `answeredByImpersonator`); a steer or local turn sent so is saved marked (`lib/not-typed-text.ts`).
 * The saved-login verdict refuses both. Fails closed: only a live, unmarked session of the caller's own reads as theirs.
 * The same rule as `/chat/edit`'s `signInNotOwn`.
 */
export const callerSessionNotOwn = async (ctx: MutationCtx & { user: { impersonatedBy?: string | null; userId: string } }): Promise<boolean> => {
    if (ctx.user.impersonatedBy) {
        return true;
    }

    const signIn = requestSignIn(await ctx.auth.getIdentity().catch(() => null));

    if (signIn === undefined) {
        return true;
    }

    // From the primary: a replica can still hold a session just ended.
    const session = await ctx.db.session.findFirst({ consistency: "primary", where: { _id: signIn as Id<"session"> } }).catch(() => null);

    return !session || session.userId !== ctx.user.userId || session.expiresAt <= ctx.now || Boolean(session.impersonatedBy);
};
