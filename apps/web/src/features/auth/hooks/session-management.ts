import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import useAuthMutation from "./shared/use-auth-mutation";
import useAuthQuery from "./shared/use-auth-query";

// Session Listing Hook
export const useListSessions = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({ authClient, options, queryFn: authClient.listSessions, queryKey });
};

// All Sessions Revocation Hook
export const useRevokeSessions = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.revokeSessions,
        options,
        queryKey,
    });
};

// Single Session Revocation Hook
export const useRevokeSession = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.revokeSession,
        options,
        queryKey,
    });
};

// Other Sessions Revocation Hook
export const useRevokeOtherSessions = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listSessionsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.revokeOtherSessions,
        options,
        queryKey,
    });
};
