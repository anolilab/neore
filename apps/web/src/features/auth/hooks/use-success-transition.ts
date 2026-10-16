import { useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";

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
    // Counts successful sign-ins on this mounted form, so each one navigates once.
    const [successCount, setSuccessCount] = useState(0);

    const { authClient, navigate, onSessionChange } = useAuth();

    const { refetch: refetchSession } = useSession(authClient);

    const onNavigate = useEffectEvent((redirectTo: string) => {
        startTransition(() => {
            navigate(redirectTo);
        });
    });

    // `isPending` flips true → false around each transition, and the effect below
    // depends on it. Without this guard every navigation re-ran the effect and
    // navigated again, which re-ran the root `beforeLoad` (one server-function call
    // per pass). Navigate once per success; a later success gets a new count.
    const navigatedForRef = useRef(0);

    useEffect(() => {
        if (successCount === 0 || isPending || navigatedForRef.current === successCount) {
            return;
        }

        navigatedForRef.current = successCount;
        onNavigate(getRedirectTo());
    }, [successCount, isPending, getRedirectTo]);

    const onSuccess = useCallback(async () => {
        await refetchSession?.();

        if (!stayOnPage) {
            setSuccessCount((count) => count + 1);
        }

        if (onSessionChange) {
            startTransition(onSessionChange);
        }
    }, [refetchSession, onSessionChange, stayOnPage]);

    return { isPending, onSuccess };
};

export default useOnSuccessTransition;
