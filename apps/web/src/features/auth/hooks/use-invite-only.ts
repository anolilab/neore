import useIsHydrated from "@neore/ui/hooks/use-hydrated";

import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { INVITE_TOKEN_PARAM, readInviteToken } from "@/features/auth/lib/invite-token";

/**
 * Whether this visitor needs to sign in before they can chat: a signed-out
 * visitor or a guest, while registration is invite-only. Unknown counts as
 * invite-only, so nothing is sent before the backend has answered.
 */
export const mustSignInToChat = (inviteOnly: boolean | undefined, user: { isAnonymous?: boolean | null } | null | undefined): boolean =>
    inviteOnly !== false && (!user || user.isAnonymous === true);

/** Sign-up (with the invitation token when there is one) when it is offered, else sign-in. */
export const signUpHrefFor = (canSignUp: boolean, inviteToken: string | undefined): string => {
    if (!canSignUp) {
        return "/auth/sign-in";
    }

    return inviteToken === undefined ? "/auth/sign-up" : `/auth/sign-up?${INVITE_TOKEN_PARAM}=${encodeURIComponent(inviteToken)}`;
};

/**
 * The invite-only state of this deployment, as the UI needs it.
 *
 * - `inviteOnly`: `undefined` until the backend has answered (`useSignInMethods`).
 * - `canSignUp`: offer sign-up only when registration is open, or the visitor
 *   arrived on an invitation link (`?invite=`). Hidden while unknown, so an
 *   invite-only deployment never flashes a sign-up link.
 * - `signUpHref`: where a "sign up" call to action should go: the sign-up
 *   page when it is offered, keeping the visitor's `?invite=` token so the
 *   form can redeem it; else sign-in (also while unknown).
 * - `mustSignIn`: see {@link mustSignInToChat}; only once the session read has
 *   answered, so a signed-in user whose session is still loading is not asked.
 */
const useInviteOnly = (): {
    canSignUp: boolean;
    inviteOnly: boolean | undefined;
    mustSignIn: boolean;
    signUpHref: string;
} => {
    const { inviteOnly } = useSignInMethods();
    const { hooks } = useAuth();
    const { data: sessionData, error: sessionError, isPending: isSessionPending } = hooks.useSession();
    const isHydrated = useIsHydrated();
    const inviteToken = isHydrated ? readInviteToken() : undefined;
    const hasInvitation = inviteToken !== undefined;

    const canSignUp = hasInvitation || inviteOnly === false;

    return {
        canSignUp,
        inviteOnly,
        mustSignIn: !isSessionPending && !sessionError && mustSignInToChat(inviteOnly, sessionData?.user),
        signUpHref: signUpHrefFor(canSignUp, inviteToken),
    };
};

export default useInviteOnly;
