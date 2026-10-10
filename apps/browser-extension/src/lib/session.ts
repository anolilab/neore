import { authClient } from "./auth";
import { signOutGrant, useGrantUser } from "./extension-grant";
import { IS_FIREFOX } from "./target";

/**
 * The signed-in user, the same shape for both builds.
 *
 * Chrome reads better-auth's cookie session on the app origin; Firefox reads the
 * bearer grant it holds itself (`extension-grant.ts`). `IS_FIREFOX` is a
 * build-time constant, so each build calls one hook, always — the rules of hooks
 * hold.
 */
export interface ExtensionSession {
    /** Changes when the signed-in session does; for effect dependencies, not display. */
    sessionId: string;
    user: { email: string; id: string; image?: string | null; name?: string | null };
}

const useCookieSession = (): { data: ExtensionSession | null; isPending: boolean } => {
    const { data, isPending } = authClient.useSession();

    return {
        data: data?.session ? { sessionId: data.session.id, user: data.user } : null,
        isPending,
    };
};

const useGrantSession = (): { data: ExtensionSession | null; isPending: boolean } => {
    const { isPending, user } = useGrantUser();

    return { data: user ? { sessionId: user.id, user } : null, isPending };
};

export const useSession = IS_FIREFOX ? useGrantSession : useCookieSession;

export const signOut = async (): Promise<void> => {
    if (IS_FIREFOX) {
        await signOutGrant();

        return;
    }

    await authClient.signOut();
};
