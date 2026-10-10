import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import type { ApiKey } from "../types/data-structure-types";
import useAuthMutation from "./shared/use-auth-mutation";
import type { BetterFetchRequest } from "./shared/use-auth-query";
import useAuthQuery from "./shared/use-auth-query";

type AuthMutationFunction = (parameters: Record<string, unknown>) => Promise<unknown>;

type AuthClientWithApiKey = AuthClient & {
    apiKey: {
        create: AuthMutationFunction;
        delete: AuthMutationFunction;
        /** better-auth's api-key plugin answers a page (`{ apiKeys, total, limit, offset }`), not a bare array. */
        list: BetterFetchRequest<{ apiKeys: ApiKey[]; total: number }>;
    };
};

// API Key Creation Hook
export const useCreateApiKey = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listApiKeysKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: (authClient as unknown as AuthClientWithApiKey).apiKey.create,
        options,
        queryKey,
    });
};

// API Key Deletion Hook
export const useDeleteApiKey = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listApiKeysKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: (authClient as unknown as AuthClientWithApiKey).apiKey.delete,
        options,
        queryKey,
    });
};

// API Key Listing Hook
export const useListApiKeys = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listApiKeysKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({
        authClient,
        options,
        queryFn: (authClient as unknown as AuthClientWithApiKey).apiKey.list,
        queryKey,
    });
};
