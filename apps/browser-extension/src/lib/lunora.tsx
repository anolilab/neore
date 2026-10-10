import { LunoraProvider } from "@lunora/react";
import type { ReactNode } from "react";
import { useEffect } from "react";

import { clearAccessToken, getAccessToken, tokenExpiresAt } from "./access-token";
import { lunora } from "./lunora-client";
import { useSession } from "./session";

/** Never refresh more often than this, whatever `exp` says. */
const MIN_REFRESH_DELAY_MS = 30_000;

/**
 * Keeps the Lunora client's bearer token in step with the better-auth session.
 *
 * `setAuthToken` takes a token, not a fetcher, so this also schedules the
 * refresh: the JWT is short-lived, and without one every query would go
 * anonymous a few minutes after sign-in.
 */
export function LunoraWithAuthProvider({ children }: { children: ReactNode }) {
    const { data: session } = useSession();
    const sessionId = session?.sessionId;

    useEffect(() => {
        if (!sessionId) {
            clearAccessToken();
            lunora.setAuthToken(null);

            return undefined;
        }

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const refresh = async (force: boolean) => {
            const token = await getAccessToken({ force });

            if (cancelled) {
                return;
            }

            lunora.setAuthToken(token);

            const expiresAt = token ? tokenExpiresAt(token) : undefined;

            if (expiresAt !== undefined) {
                timer = setTimeout(
                    () => {
                        void refresh(true);
                    },
                    Math.max(MIN_REFRESH_DELAY_MS, expiresAt - Date.now() - 60_000),
                );
            }
        };

        void refresh(false);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [sessionId]);

    return <LunoraProvider client={lunora}>{children}</LunoraProvider>;
}
