import { useIsRestoring, useQueryClient } from "@tanstack/react-query";
import { use, useCallback, useMemo } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AnyAuthClient } from "../../types/auth-core-types";
import type { AuthHooks, AuthMutators } from "../../types/hook-integration-types";
import { AuthQueryContext } from "../auth-query-provider";
import createAuthHooks from "../create-auth-hooks";

const useTanstackOptions = ({ authClient }: { authClient: AnyAuthClient }) => {
    const { useDeletePasskey, useRevokeDeviceSession, useRevokeSession, useSetActiveSession, useUnlinkAccount, useUpdateUser } = createAuthHooks(
        authClient as AuthClient,
    );
    const queryClient = useQueryClient();

    const { mutateAsync: updateUserAsync } = useUpdateUser();
    const { mutateAsync: deletePasskeyAsync } = useDeletePasskey();
    const { mutateAsync: unlinkAccountAsync } = useUnlinkAccount();
    const { mutateAsync: revokeSessionAsync } = useRevokeSession();
    const { mutateAsync: revokeDeviceSessionAsync } = useRevokeDeviceSession();
    const { setActiveSessionAsync } = useSetActiveSession();
    const { sessionKey } = use(AuthQueryContext);

    const hooks = useMemo(() => {
        return {
            ...(createAuthHooks(authClient as AuthClient) as unknown as Partial<AuthHooks>),
            useIsRestoring,
        };
    }, [authClient]);

    const mutators = useMemo(
        () =>
            ({
                deletePasskey: async (parameters) => {
                    const { error } = (await deletePasskeyAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
                revokeDeviceSession: async (parameters) => {
                    const { error } = (await revokeDeviceSessionAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
                revokeSession: async (parameters) => {
                    const { error } = (await revokeSessionAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
                setActiveSession: async (parameters) => {
                    const { error } = (await setActiveSessionAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
                unlinkAccount: async (parameters) => {
                    const { error } = (await unlinkAccountAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
                updateUser: async (parameters) => {
                    const { error } = (await updateUserAsync({
                        ...parameters,
                        fetchOptions: { throw: false },
                    })) as { error?: unknown };

                    if (error) {
                        throw error;
                    }
                },
            }) as AuthMutators,
        [updateUserAsync, deletePasskeyAsync, unlinkAccountAsync, revokeSessionAsync, revokeDeviceSessionAsync, setActiveSessionAsync],
    );

    const onSessionChange = useCallback(async () => {
        await queryClient.refetchQueries({ queryKey: sessionKey });

        queryClient.invalidateQueries({
            predicate: (query) => query.queryKey !== sessionKey,
        });
    }, [queryClient, sessionKey]);

    return {
        hooks,
        mutators,
        onSessionChange,
        optimistic: true,
    };
};

export default useTanstackOptions;
