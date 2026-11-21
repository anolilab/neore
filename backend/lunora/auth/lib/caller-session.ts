import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { hasNotTypedMarks, type NotTypedMarks } from "../../lib/not-typed-text";
import { requestSignIn, requestSignInIsGrant } from "./request-sign-in";
import { notTypedMarksOfStanding, signInStanding } from "./sign-in-standing";

type CallerCtx = MutationCtx & { user: { impersonatedBy?: string | null; userId: string } };

/**
 * The not-typed marks (`lib/not-typed-text.ts`) of what a cRPC caller sends: `impersonated` for an admin acting as the
 * owner or a sign-in whose session row cannot be read as theirs (none named, gone, another user's or expired, as an
 * ended impersonation whose token has not yet expired), `extension` for a browser extension's grant or a grant whose
 * app cannot be told (`sign-in-standing.ts`). A steer or local turn sent so is saved marked. Fails closed: only a live,
 * unmarked web session of the caller's own, or a grant of their own desktop or phone app, marks nothing. The same rule
 * as `/chat/start`'s and `/chat/edit`'s session reads.
 */
export const callerSessionMarks = async (ctx: CallerCtx): Promise<NotTypedMarks> => {
    if (ctx.user.impersonatedBy) {
        return { impersonated: true };
    }

    const identity = await ctx.auth.getIdentity().catch(() => null);
    const signIn = requestSignIn(identity);

    if (signIn === undefined) {
        return { impersonated: true };
    }

    // From the primary: a replica can still hold a session just ended.
    const session = await ctx.db.session.findFirst({ consistency: "primary", where: { _id: signIn as Id<"session"> } }).catch(() => null);

    return notTypedMarksOfStanding(signInStanding(session, { now: ctx.now, userId: ctx.user.userId, viaGrant: requestSignInIsGrant(identity) }));
};

/**
 * Whether what a cRPC caller answers may NOT count as the owner's own ({@link callerSessionMarks} marks it): an approval,
 * question or secret answered so marks its continuation impersonated (`claimToolApproval`'s `answeredByImpersonator`).
 * The saved-login verdict refuses it.
 */
export const callerSessionNotOwn = async (ctx: CallerCtx): Promise<boolean> => hasNotTypedMarks(await callerSessionMarks(ctx));
