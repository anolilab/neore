import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import type { AuthClientWithMultiSessionPlugin } from "../types/auth-core-types";
import useAuthMutation from "./shared/use-auth-mutation";
import useAuthQuery from "./shared/use-auth-query";
import useOnMutateError from "./shared/use-mutate-error";

// Device Session Listing Hook
export const useListDeviceSessions = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listDeviceSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({
        authClient,
        options,
        queryFn: (authClient as unknown as AuthClientWithMultiSessionPlugin).multiSession.listDeviceSessions,
        queryKey,
    });
};

// Single Device Session Revocation Hook
export const useRevokeDeviceSession = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listDeviceSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: (authClient as unknown as AuthClientWithMultiSessionPlugin).multiSession.revoke,
        options,
        queryKey,
    });
};

// All Device Sessions Revocation Hook
export const useRevokeDeviceSessions = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listDeviceSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.revokeSessions,
        options,
        queryKey,
    });
};

// Active Session Setting Hook
export const useSetActiveSession = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    type SetActiveSessionParameters = Parameters<AuthClientWithMultiSessionPlugin["multiSession"]["setActive"]>[0];

    const queryClient = useQueryClient();
    const { onMutateError } = useOnMutateError();
    const context = use(AuthQueryContext);
    const { listDeviceSessionsKey: queryKey } = { ...context, ...options };

    const mutation = useMutation({
        mutationFn: ({ fetchOptions = { throw: true }, ...parameters }: SetActiveSessionParameters) =>
            (authClient as unknown as AuthClientWithMultiSessionPlugin).multiSession.setActive({ fetchOptions, ...parameters }),
        onError: (error) => {
            onMutateError(error, queryKey);
        },
        onSettled: () => {
            queryClient.clear();
        },
    });

    const { error: setActiveSessionError, isPending: setActiveSessionPending, mutate: setActiveSession, mutateAsync: setActiveSessionAsync } = mutation;

    return {
        ...mutation,
        setActiveSession,
        setActiveSessionAsync,
        setActiveSessionError,
        setActiveSessionPending,
    };
};
