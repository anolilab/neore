"use client";

import type { FC, ReactNode } from "react";
import { useEffect } from "react";

import AutoGuestSignIn from "@/features/auth/components/auto-guest-signin";
import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { adoptSessionTokenWhileShut } from "@/features/auth/lib/guest-session";
import getSessionToken from "@/lib/auth/server-functions";
import { useLunora } from "@/lib/lunora/crpc";

/**
 * A session the RPC client has not picked up yet (`<Unauthenticated>` means "no
 * token", not "no session"): keep handing it the token until the gate opens.
 * `AutoGuestSignIn` does the same after a guest sign-in; without it a signed-in
 * visitor could be left on the signed-out page for good.
 */
const AdoptSession: FC<{ children: ReactNode }> = ({ children }) => {
    const lunoraClient = useLunora();

    useEffect(() => {
        const adoption = new AbortController();

        void adoptSessionTokenWhileShut(lunoraClient, getSessionToken, adoption.signal);

        return () => {
            adoption.abort();
        };
    }, [lunoraClient]);

    return children;
};

/**
 * What a route under `<Unauthenticated>` (the RPC client has no token) shows.
 *
 * Registration open: a guest session is made, as it always was
 * (`AutoGuestSignIn`). Invite-only: no guest (the backend refuses one), and
 * `signedOut` instead. Until the backend has said which
 * (`useSignInMethods().inviteOnly`), and while the session read is pending or
 * failed, `loading`, so no guest is made early and no signed-out page flashes
 * over a session that exists.
 */
const UnauthenticatedGate: FC<{ loading: ReactNode; signedOut: ReactNode }> = ({ loading, signedOut }) => {
    const { inviteOnly } = useSignInMethods();
    const { hooks } = useAuth();
    const { data: sessionData, error: sessionError, isPending: isSessionPending } = hooks.useSession();

    if (inviteOnly === undefined) {
        return loading;
    }

    if (!inviteOnly) {
        return <AutoGuestSignIn />;
    }

    if (sessionData?.user) {
        return <AdoptSession>{loading}</AdoptSession>;
    }

    if (isSessionPending || sessionError) {
        return loading;
    }

    return signedOut;
};

export default UnauthenticatedGate;
