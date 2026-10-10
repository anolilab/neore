import type { AnyUseQueryOptions } from "@tanstack/react-query";

import type { AuthClient } from "@/lib/auth/client";

import type { AnyAuthClient } from "../types/auth-core-types";
import useAuthQuery from "./shared/use-auth-query";

// Active Organization Hook
export const useActiveOrganization = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const queryKey = ["active-organization"];

    return useAuthQuery({
        authClient,
        options,
        queryFn: authClient.organization.getFullOrganization,
        queryKey,
    });
};

// Organization Listing Hook
export const useListOrganizations = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const queryKey = ["organizations"];

    return useAuthQuery({
        authClient,
        options,
        queryFn: authClient.organization.list,
        queryKey,
    });
};

// Invitation Details Hook
export const useInvitation = <TAuthClient extends AnyAuthClient>(
    authClient: TAuthClient,
    parameters: Parameters<AuthClient["organization"]["getInvitation"]>[0],
    options?: Partial<AnyUseQueryOptions>,
) => {
    const queryKey = ["invitation", JSON.stringify(parameters)];

    return useAuthQuery({
        authClient,
        options,
        queryFn: (functionParameters) => (authClient as AuthClient).organization.getInvitation({ ...parameters, ...functionParameters }),
        queryKey,
    });
};

// Permission Check Hook
export const useHasPermission = <TAuthClient extends AnyAuthClient>(
    authClient: TAuthClient,
    parameters: Parameters<AuthClient["organization"]["hasPermission"]>[0],
    options?: Partial<AnyUseQueryOptions>,
) => {
    const queryKey = ["has-permission", JSON.stringify(parameters)];

    return useAuthQuery({
        authClient,
        options,
        queryFn: (functionParameters) => (authClient as AuthClient).organization.hasPermission({ ...parameters, ...functionParameters }),
        queryKey,
    });
};
