import type { AnyUseQueryOptions, QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import { useListAccounts, useUnlinkAccount } from "../hooks/account-management";
import { useCreateApiKey, useDeleteApiKey, useListApiKeys } from "../hooks/api-key-management";
import { useListDeviceSessions, useRevokeDeviceSession, useRevokeDeviceSessions, useSetActiveSession } from "../hooks/device-session-management";
import { useActiveOrganization, useHasPermission, useInvitation, useListOrganizations } from "../hooks/organization-management";
import { useDeletePasskey, useListPasskeys } from "../hooks/passkey-management";
import { useListSessions, useRevokeOtherSessions, useRevokeSession, useRevokeSessions } from "../hooks/session-management";
import { useSession, useUpdateUser } from "../hooks/session-user-management";
import useAuthMutation from "../hooks/shared/use-auth-mutation";
import type { BetterFetchRequest } from "../hooks/shared/use-auth-query";
import useAuthQuery from "../hooks/shared/use-auth-query";
import { useToken } from "../hooks/token/use-token";
import type { AuthQueryOptions } from "./auth-query-provider";
import { AuthQueryContext } from "./auth-query-provider";
import prefetchSession from "./prefetch-session";

const createAuthHooks = (authClient: AuthClient) => {
    return {
        useActiveOrganization: (options?: Partial<AnyUseQueryOptions>) => useActiveOrganization(authClient, options),
        useAuthMutation,
        useAuthQuery: <TData>({
            options,
            queryFn,
            queryKey,
        }: {
            options?: Partial<AnyUseQueryOptions>;
            queryFn: BetterFetchRequest<TData>;
            queryKey: QueryKey;
        }) => useAuthQuery({ authClient, options, queryFn, queryKey }),
        useCreateApiKey: (options?: Partial<AuthQueryOptions>) => useCreateApiKey(authClient, options),
        useDeleteApiKey: (options?: Partial<AuthQueryOptions>) => useDeleteApiKey(authClient, options),
        useDeletePasskey: (options?: Partial<AuthQueryOptions>) => useDeletePasskey(authClient, options),
        useHasPermission: (parameters: Parameters<AuthClient["organization"]["hasPermission"]>[0], options?: Partial<AnyUseQueryOptions>) =>
            useHasPermission(authClient, parameters, options),
        useInvitation: (parameters: Parameters<AuthClient["organization"]["getInvitation"]>[0], options?: Partial<AnyUseQueryOptions>) =>
            useInvitation(authClient, parameters, options),
        useListAccounts: (options?: Partial<AnyUseQueryOptions>) => useListAccounts(authClient, options),
        useListApiKeys: (options?: Partial<AnyUseQueryOptions>) => useListApiKeys(authClient, options),
        useListDeviceSessions: (options?: Partial<AnyUseQueryOptions>) => useListDeviceSessions(authClient, options),
        useListOrganizations: (options?: Partial<AnyUseQueryOptions>) => useListOrganizations(authClient, options),
        useListPasskeys: (options?: Partial<AnyUseQueryOptions>) => useListPasskeys(authClient, options),
        useListSessions: (options?: Partial<AnyUseQueryOptions>) => useListSessions(authClient, options),
        usePrefetchSession: (options?: Partial<AnyUseQueryOptions>) => {
            const queryClient = useQueryClient();
            const queryOptions = use(AuthQueryContext);

            return {
                prefetch: () => prefetchSession(authClient, queryClient, queryOptions, options),
            };
        },
        useRevokeDeviceSession: (options?: Partial<AuthQueryOptions>) => useRevokeDeviceSession(authClient, options),
        useRevokeDeviceSessions: (options?: Partial<AuthQueryOptions>) => useRevokeDeviceSessions(authClient, options),
        useRevokeOtherSessions: (options?: Partial<AuthQueryOptions>) => useRevokeOtherSessions(authClient, options),
        useRevokeSession: (options?: Partial<AuthQueryOptions>) => useRevokeSession(authClient, options),
        useRevokeSessions: (options?: Partial<AuthQueryOptions>) => useRevokeSessions(authClient, options),
        useSession: (options?: Partial<AnyUseQueryOptions>) => useSession(authClient, options),
        useSetActiveSession: (options?: Partial<AuthQueryOptions>) => useSetActiveSession(authClient, options),
        useToken: (options?: Partial<AnyUseQueryOptions>) => useToken(authClient, options),
        useUnlinkAccount: () => useUnlinkAccount(authClient),
        useUpdateUser: (options?: Partial<AuthQueryOptions>) => useUpdateUser(authClient, options),
    };
};

export default createAuthHooks;
