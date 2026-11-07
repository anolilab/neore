import { useCallback, useMemo } from "react";

import type { AuthUIProviderProps } from "../auth-ui-provider";
import { AuthUIProvider } from "../auth-ui-provider";
import useTanstackOptions from "./use-tanstack-options";

const AuthUIProviderTanstack = ({
    authClient,
    children,
    hooks: hooksProperty,
    mutators: mutatorsProperty,
    onSessionChange: onSessionChangeProperty,
    onSessionChangeStart,
    ...properties
}: AuthUIProviderProps & {
    /** Runs at once when the session changes, before the session is read again: for state that must not outlive the old account. */
    onSessionChangeStart?: () => void;
}) => {
    const { hooks: contextHooks, mutators: contextMutators, onSessionChange, optimistic } = useTanstackOptions({ authClient });

    const hooks = useMemo(() => {
        return { ...contextHooks, ...hooksProperty };
    }, [contextHooks, hooksProperty]);
    const mutators = useMemo(() => {
        const merged = { ...contextMutators, ...mutatorsProperty };
        const { setActiveSession } = merged;

        // Every account switch (the account menu, the settings dialog) goes through here: state that must not outlive the
        // old account is let go before the switch starts.
        return {
            ...merged,
            setActiveSession: async (...parameters: Parameters<typeof setActiveSession>) => {
                onSessionChangeStart?.();

                return await setActiveSession(...parameters);
            },
        };
    }, [contextMutators, mutatorsProperty, onSessionChangeStart]);

    const onSessionChangeCallback = useCallback(async () => {
        onSessionChangeStart?.();
        await onSessionChange();
        await onSessionChangeProperty?.();
    }, [onSessionChangeProperty, onSessionChange, onSessionChangeStart]);

    return (
        <AuthUIProvider
            authClient={authClient}
            hooks={hooks}
            mutators={mutators}
            onSessionChange={onSessionChangeCallback}
            optimistic={optimistic}
            {...properties}
        >
            {children}
        </AuthUIProvider>
    );
};

export default AuthUIProviderTanstack;
