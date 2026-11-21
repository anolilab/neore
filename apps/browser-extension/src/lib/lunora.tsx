import { LunoraProvider } from "@lunora/react";
import type { ReactNode } from "react";
import { useEffect } from "react";

import { clearAccessToken, getAccessToken } from "./access-token";
import { keepAuthToken } from "./auth-token-sync";
import { lunora } from "./lunora-client";
import { useSession } from "./session";

/** Keeps the Lunora client's bearer in step with the stored grant (`keepAuthToken`). */
export function LunoraWithAuthProvider({ children }: { children: ReactNode }) {
    const { data: session } = useSession();
    const sessionId = session?.sessionId;
    const userId = session?.user.id;

    useEffect(() => {
        if (!sessionId || !userId) {
            clearAccessToken();
            lunora.setAuthToken(null);

            return undefined;
        }

        return keepAuthToken(lunora, userId, getAccessToken);
    }, [sessionId, userId]);

    return <LunoraProvider client={lunora}>{children}</LunoraProvider>;
}
