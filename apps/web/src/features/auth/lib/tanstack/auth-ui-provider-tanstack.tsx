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
    onSessionSwitch,
    ...properties
}: AuthUIProviderProps & {
    /**
     * For state that must not outlive the old account: called with "before" as an account switch starts (it may still fail),
     * and with "after" once the session has changed, before the new one is read.
     */
    onSessionSwitch?: (phase: "after" | "before") => void;
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
                onSessionSwitch?.("before");

                const result = await setActiveSession(...parameters);

                onSessionSwitch?.("after");

                return result;
            },
        };
    }, [contextMutators, mutatorsProperty, onSessionSwitch]);

    const onSessionChangeCallback = useCallback(async () => {
        onSessionSwitch?.("after");
        await onSessionChange();
        await onSessionChangeProperty?.();
    }, [onSessionChangeProperty, onSessionChange, onSessionSwitch]);

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
