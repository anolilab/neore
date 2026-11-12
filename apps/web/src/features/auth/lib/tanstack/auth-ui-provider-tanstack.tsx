import { useCallback, useMemo } from "react";

import type { AuthUIProviderProps } from "../auth-ui-provider";
import { AuthUIProvider } from "../auth-ui-provider";
import { clearLastAccountHint } from "../last-account-hint";
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
     * and with "after" once the switch has gone through. A sign-in is not a switch and calls neither.
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

                // Only once the switch went through: the account left is no longer "the last one signed in", and the
                // new one writes it when confirmed. A failed switch keeps it, since that account is still signed in.
                clearLastAccountHint();

                onSessionSwitch?.("after");

                return result;
            },
        };
    }, [contextMutators, mutatorsProperty, onSessionSwitch]);

    // Not a switch: this runs after every sign-in too, where the open document is still the reader's own.
    const onSessionChangeCallback = useCallback(async () => {
        await onSessionChange();
        await onSessionChangeProperty?.();
    }, [onSessionChangeProperty, onSessionChange]);

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
