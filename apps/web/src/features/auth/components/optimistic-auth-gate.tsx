"use client";

import { useAuthState } from "@lunora/react";
import type { SessionAuthStatus } from "@neore/client-runtime";
import type { FC, ReactNode } from "react";
import { useSyncExternalStore } from "react";

import { hasLastAccountHint, subscribeLastAccountHint } from "@/features/auth/lib/last-account-hint";

const noHintOnServer = (): boolean => false;

/**
 * The chat layout's auth gate. Lunora's identity store reads "loading" on the server, while hydrating, and on the
 * client until its identity probe answers; showing a skeleton for all of that hid a layout whose data the loader
 * had already sent. While it loads, this paints the signed-in layout when the session is known to exist:
 *
 * - `serverAuthStatus === "authenticated"`: the root `beforeLoad` read the session cookie and minted the RPC token
 *   (on the client, the dehydrated value, so the hydration render matches the server's);
 * - or, after hydration, `localStorage` still holds the last confirmed account (`last-account-hint.ts`), unless the
 *   server has ANSWERED "no session".
 *
 * Nothing else changes: once Lunora settles, `authenticated` shows exactly where `<Authenticated>` did and
 * `unauthenticated` where `<Unauthenticated>` did (`AuthRecovery` clears the cache and the hint). The same element
 * type stays in place from the optimistic phase into the confirmed one, so the layout never remounts.
 */
const OptimisticAuthGate: FC<{
    authenticated: ReactNode;
    loading: ReactNode;
    serverAuthStatus: SessionAuthStatus | undefined;
    unauthenticated: ReactNode;
}> = ({ authenticated, loading, serverAuthStatus, unauthenticated }) => {
    const { isAuthenticated, isLoading } = useAuthState();
    // Server snapshot `false`: neither the server render nor the hydration render reads storage.
    const hasHint = useSyncExternalStore(subscribeLastAccountHint, hasLastAccountHint, noHintOnServer);

    if (isAuthenticated) {
        return authenticated;
    }

    if (!isLoading) {
        return unauthenticated;
    }

    if (serverAuthStatus === "authenticated" || (hasHint && serverAuthStatus !== "unauthenticated")) {
        return authenticated;
    }

    return loading;
};

export default OptimisticAuthGate;
