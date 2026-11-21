import { LunoraProvider } from "@lunora/react";
import type { ReactNode } from "react";
import { useEffect } from "react";

import { clearAccessToken, getAccessToken } from "./access-token";
import { createAuthTokenSync } from "./auth-token-sync";
import { lunora } from "./lunora-client";
import { useSession } from "./session";

const authTokenSync = createAuthTokenSync(lunora, getAccessToken);

/** Keeps the Lunora client's bearer in step with the stored grant (`createAuthTokenSync`). */
export function LunoraWithAuthProvider({ children }: { children: ReactNode }) {
    const { data: session } = useSession();
    const sessionId = session?.sessionId;
    const userId = session?.user.id;

    useEffect(() => {
        if (!sessionId || !userId) {
            clearAccessToken();
            authTokenSync.signOut();

            return undefined;
        }

        return authTokenSync.start(userId);
    }, [sessionId, userId]);

    return <LunoraProvider client={lunora}>{children}</LunoraProvider>;
}
