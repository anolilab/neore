import { useCallback, useMemo } from "react";

import { authClient as sessionSource } from "@/lib/auth/client";

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
     * and with "after" once the switch has gone through, each with the departing user (read before the switch; undefined when
     * the session was not read). A sign-in is not a switch and calls neither.
     */
    onSessionSwitch?: (phase: "after" | "before", departingUserId: string | undefined) => void;
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
                // The app's session (the client passed in is the same one), read without making the mutators depend on it.
                const departing = sessionSource.$store.atoms.session?.get().data?.user.id;

                onSessionSwitch?.("before", departing);

                const result = await setActiveSession(...parameters);

                onSessionSwitch?.("after", departing);

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
