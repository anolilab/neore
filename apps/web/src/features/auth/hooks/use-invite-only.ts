import useIsHydrated from "@neore/ui/hooks/use-hydrated";

import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { readInviteToken } from "@/features/auth/lib/invite-token";

/**
 * Whether this visitor needs to sign in before they can chat: a signed-out
 * visitor or a guest, while registration is invite-only. Unknown counts as
 * invite-only, so nothing is sent before the backend has answered.
 */
export const mustSignInToChat = (inviteOnly: boolean | undefined, user: { isAnonymous?: boolean | null } | null | undefined): boolean =>
    inviteOnly !== false && (!user || user.isAnonymous === true);

/**
 * The invite-only state of this deployment, as the UI needs it.
 *
 * - `inviteOnly`: `undefined` until the backend has answered (`useSignInMethods`).
 * - `canSignUp`: offer sign-up only when registration is open, or the visitor
 *   arrived on an invitation link (`?invite=`). Hidden while unknown, so an
 *   invite-only deployment never flashes a sign-up link.
 * - `mustSignIn`: see {@link mustSignInToChat}; only once the session read has
 *   answered, so a signed-in user whose session is still loading is not asked.
 */
const useInviteOnly = (): { canSignUp: boolean; inviteOnly: boolean | undefined; mustSignIn: boolean } => {
    const { inviteOnly } = useSignInMethods();
    const { hooks } = useAuth();
    const { data: sessionData, error: sessionError, isPending: isSessionPending } = hooks.useSession();
    const isHydrated = useIsHydrated();
    const hasInvitation = isHydrated && readInviteToken() !== undefined;

    return {
        canSignUp: hasInvitation || inviteOnly === false,
        inviteOnly,
        mustSignIn: !isSessionPending && !sessionError && mustSignInToChat(inviteOnly, sessionData?.user),
    };
};

export default useInviteOnly;
