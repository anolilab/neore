import { useAuth as useLunoraIdentity } from "@lunora/react";
import { useEffect, useEffectEvent } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import { openLoginPrompt } from "@/features/auth/stores/login-prompt-store";
import { savePendingSend, takePendingSend } from "@/features/chat/core/utils/pending-send";
import { useLunoraAuth } from "@/lib/lunora/crpc";

/** Hold `text` for after sign-in and ask the visitor to sign in; nothing is sent. */
export const holdForSignIn = (text: string): void => {
    savePendingSend(text);
    openLoginPrompt();
};

/** The `sub` of a JWT, read without verifying it: only used to see whether the RPC client has caught up. */
export const tokenSubject = (token: string | null | undefined): string | undefined => {
    const payload = token?.split(".", 2)[1];

    if (!payload) {
        return undefined;
    }

    try {
        const { sub } = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/"))) as { sub?: unknown };

        return typeof sub === "string" ? sub : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Whether a message held for after sign-in (`pending-send.ts`) may go out now:
 * a real (non-guest) account is signed in AND the RPC client already carries
 * that account's token. A guest who signs in keeps the guest's token on the
 * client for a moment (`AuthRecovery` swaps it); sending in that window would
 * post as the guest.
 */
export const useCanTakePendingSend = (): boolean => {
    const { isAnonymous, user } = useIsAnonymous();
    const { isAuthenticated } = useLunoraAuth();
    const { token } = useLunoraIdentity();

    return Boolean(user && !isAnonymous && isAuthenticated && tokenSubject(token) === user.id);
};

/**
 * Sends the message held for after sign-in (`pending-send.ts`) through `send`,
 * once, as soon as {@link useCanTakePendingSend} allows. Taking it removes it,
 * so a second composer or effect run finds nothing.
 */
const usePendingSend = (enabled: boolean, send: (text: string) => void): void => {
    const canTake = useCanTakePendingSend();
    const onSend = useEffectEvent(send);

    useEffect(() => {
        if (!enabled || !canTake) {
            return;
        }

        const pending = takePendingSend();

        if (pending !== undefined) {
            onSend(pending);
        }
    }, [canTake, enabled]);
};

export default usePendingSend;
