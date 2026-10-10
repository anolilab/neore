import { useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useState, useTransition } from "react";

import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

/**
 * `stayOnPage`: refresh the session and notify, but do not navigate. For a
 * sign-in the visitor did not ask for (the auto guest on `/chat`), where the
 * page they are on IS where they wanted to be — `redirectTo` falls back to "/",
 * which would move them to the landing page.
 */
const useOnSuccessTransition = ({ redirectTo: redirectToProperty, stayOnPage = false }: { redirectTo?: string; stayOnPage?: boolean }) => {
    const { redirectTo: contextRedirectTo } = useAuth();
    const search = useSearch({ strict: false });

    const getRedirectTo = useCallback(
        () => redirectToProperty || search?.redirectTo || contextRedirectTo,
        [redirectToProperty, search?.redirectTo, contextRedirectTo],
    );

    const [isPending, startTransition] = useTransition();
    const [success, setSuccess] = useState(false);

    const { authClient, navigate, onSessionChange } = useAuth();

    const { refetch: refetchSession } = useSession(authClient);

    const onNavigate = useEffectEvent((redirectTo: string) => {
        startTransition(() => {
            navigate(redirectTo);
        });
    });

    useEffect(() => {
        if (!success || isPending) {
            return;
        }

        onNavigate(getRedirectTo());
    }, [success, isPending, getRedirectTo]);

    const onSuccess = useCallback(async () => {
        await refetchSession?.();

        if (!stayOnPage) {
            setSuccess(true);
        }

        if (onSessionChange) {
            startTransition(onSessionChange);
        }
    }, [refetchSession, onSessionChange, stayOnPage]);

    return { isPending, onSuccess };
};

export default useOnSuccessTransition;
