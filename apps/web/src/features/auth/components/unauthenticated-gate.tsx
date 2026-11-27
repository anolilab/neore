"use client";

import type { FC, ReactNode } from "react";
import { useEffect, useState } from "react";

import AutoGuestSignIn from "@/features/auth/components/auto-guest-signin";
import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import useSignInMethods from "@/features/auth/hooks/use-sign-in-methods";
import { adoptSessionTokenWhileShut } from "@/features/auth/lib/guest-session";
import { useConnectionView } from "@/features/connection/hooks/use-connection";
import { rereadFailedSession } from "@/lib/auth/client";
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

/** A session read that failed, as opposed to one the server answered: a 401 is "no session", not a failure. */
const isUnanswered = (error: unknown): boolean => error != null && (error as { status?: unknown }).status !== 401;

/**
 * Whether a session read that failed during an outage is still waiting to be read
 * again. It holds from the moment the connection is not `online` with such a
 * failure until a re-read, started once the view is back `online`, has settled:
 * the browser's `online` event does not fire after a server-only outage, and a
 * stale failure must not read as signed out in the meantime.
 */
const useOutageReadPending = (connectionView: string, hasUnansweredRead: boolean): boolean => {
    const [pending, setPending] = useState(false);

    if (connectionView !== "online" && hasUnansweredRead && !pending) {
        setPending(true);
    }

    useEffect(() => {
        if (connectionView !== "online" || !pending) {
            return undefined;
        }

        const reread = new AbortController();

        const settle = async () => {
            await rereadFailedSession(reread.signal);

            if (!reread.signal.aborted) {
                setPending(false);
            }
        };

        void settle();

        return () => {
            reread.abort();
        };
    }, [connectionView, pending]);

    return pending;
};

/**
 * What a route under `<Unauthenticated>` (the RPC client has no token) shows.
 *
 * Registration open: a guest session is made, as it always was
 * (`AutoGuestSignIn`). Invite-only: no guest (the backend refuses one), and
 * `signedOut` instead. Until the backend has said which
 * (`useSignInMethods().inviteOnly`), and while the session read is pending,
 * `loading`, so no guest is made early and no signed-out page flashes over a
 * session that exists. A failed read with no session shows `signedOut`, except
 * while the connection is down: a read that failed offline is no answer, so it
 * stays `loading` (the offline screen or the banner says why) and never shows
 * the signed-out page, redirects to sign-in or makes a guest, and it stays
 * `loading` once the connection is back until the session has been read again.
 * An answered "no session" is still signed out, offline or not.
 */
const UnauthenticatedGate: FC<{ loading: ReactNode; signedOut: ReactNode }> = ({ loading, signedOut }) => {
    const { inviteOnly } = useSignInMethods();
    const { data: sessionData, error: sessionError, isPending: isSessionPending } = useAuthSession();
    const connectionView = useConnectionView();
    const hasUnansweredRead = !sessionData?.user && isUnanswered(sessionError);
    const isOutageReadPending = useOutageReadPending(connectionView, hasUnansweredRead);

    if (inviteOnly === undefined) {
        return loading;
    }

    if ((connectionView !== "online" || isOutageReadPending) && hasUnansweredRead) {
        return loading;
    }

    if (!inviteOnly) {
        return <AutoGuestSignIn />;
    }

    if (sessionData?.user) {
        return <AdoptSession>{loading}</AdoptSession>;
    }

    // A failed read with no session in hand shows the signed-out page rather than loading forever; the session
    // atom keeps re-reading (`lib/auth/client.ts`), and a session that turns up is adopted above.
    if (isSessionPending) {
        return loading;
    }

    return signedOut;
};

export default UnauthenticatedGate;
