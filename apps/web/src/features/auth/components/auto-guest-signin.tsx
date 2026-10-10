"use client";

import { useLingui } from "@lingui/react/macro";
import { useEffect, useEffectEvent } from "react";

import useAnonymousSignInTracking from "@/features/auth/hooks/use-anonymous-signin-tracking";
import useOnSuccessTransition from "@/features/auth/hooks/use-success-transition";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import type { GuestSessionOutcome } from "@/features/auth/lib/guest-session";
import { adoptSessionToken, ensureGuestSession, nextAdoptionDelay } from "@/features/auth/lib/guest-session";
import { getLocalizedError } from "@/features/auth/lib/utilities";
import { trackEvent } from "@/lib/analytics";
import getSessionToken from "@/lib/auth/server-functions";
import { useLunora } from "@/lib/lunora/crpc";

/** First retry after a failed guest sign-in; doubles per failure. */
const RETRY_BASE_MS = 2000;

/** Ceiling for that backoff. */
const RETRY_MAX_MS = 30_000;

export interface AutoGuestSignInProperties {
    onSignInError?: (error: unknown) => void;
    onSignInStart?: () => void;
    onSignInSuccess?: () => void;
    redirectTo?: string;
}

const AutoGuestSignIn = ({ onSignInError, onSignInStart, onSignInSuccess, redirectTo }: AutoGuestSignInProperties) => {
    const { authClient, toast } = useAuth();
    const { t } = useLingui();
    const { trackAnonymousSignIn } = useAnonymousSignInTracking();

    const lunoraClient = useLunora();

    // Without an explicit `redirectTo`, stay put: this sign-in happens on the
    // page the visitor opened, and the provider's fallback target is "/".
    const { onSuccess } = useOnSuccessTransition({
        redirectTo,
        stayOnPage: redirectTo === undefined,
    });

    // Effect events, so the effect below depends on `authClient` alone: the
    // callbacks are not stable across renders, and re-running on each new
    // identity is what used to re-attempt sign-in.
    const handleOutcome = useEffectEvent(async (outcome: GuestSessionOutcome) => {
        if (outcome === "existing") {
            // Report success, but do NOT run the success transition.
            //
            // `onSuccess()` navigates to `redirectTo`, which defaults to "/" — so
            // running it here would yank a signed-in user off the page they are
            // already on, which is the page they wanted. That transition exists
            // to move somebody who just became authenticated; this branch is the
            // case where they already were.
            onSignInSuccess?.();

            return;
        }

        trackAnonymousSignIn();
        trackEvent("anonymous_session_started", {
            referrer: globalThis.document?.referrer || undefined,
        });

        onSignInSuccess?.();
        await onSuccess();
    });

    const handleFailure = useEffectEvent((error: unknown) => {
        console.error("Auto guest sign-in failed:", error);

        onSignInError?.(error);

        toast({
            message: getLocalizedError({ error, t }),
            variant: "error",
        });
    });

    const handleStart = useEffectEvent(() => onSignInStart?.());

    useEffect(() => {
        // StrictMode runs this effect twice, and the `<Unauthenticated>` gate can
        // remount the component. `ensureGuestSession` makes every run share ONE
        // attempt; this flag makes only the run that is still mounted act on its
        // result, so tracking, callbacks and the redirect happen once.
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let retryDelay = RETRY_BASE_MS;
        let reported = false;

        handleStart();

        // Being mounted at all means the RPC client reads unauthenticated. Once
        // a session exists that is stale, and nothing else is bound to fix it:
        // the identity probe that flipped the gate back (it reads any non-2xx as
        // "nobody") re-runs only on a token CHANGE, and `AuthRecovery` adopts a
        // token only while the client holds none. So if the gate is still shut
        // after a pause, hand the client the session's token again. The gate
        // opening unmounts this component, which cancels the timer.
        const adoptWhileShut = async () => {
            while (!cancelled) {
                await new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, nextAdoptionDelay());
                });

                if (cancelled) {
                    return;
                }

                try {
                    await adoptSessionToken(lunoraClient, getSessionToken);

                    return;
                } catch (error) {
                    console.warn("Guest session token adoption failed:", error);
                }
            }
        };

        const signInAsGuest = async () => {
            try {
                const outcome = await ensureGuestSession(authClient);

                if (cancelled) {
                    return;
                }

                await handleOutcome(outcome);

                if (!cancelled) {
                    void adoptWhileShut();
                }
            } catch (error) {
                if (cancelled) {
                    return;
                }

                // Tell the visitor once, then keep trying: a guest sign-in that
                // gives up leaves `/chat` rendering nothing at all.
                if (!reported) {
                    reported = true;
                    handleFailure(error);
                }

                timer = setTimeout(() => {
                    void signInAsGuest();
                }, retryDelay);
                retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
            }
        };

        void signInAsGuest();

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [authClient, lunoraClient]);

    // This component doesn't render anything visible
    return null;
};

export default AutoGuestSignIn;
