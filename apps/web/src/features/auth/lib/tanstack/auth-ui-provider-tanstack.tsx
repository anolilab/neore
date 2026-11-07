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
        return { ...contextMutators, ...mutatorsProperty };
    }, [contextMutators, mutatorsProperty]);

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
