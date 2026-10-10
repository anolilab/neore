import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import type { AuthClientWithPasskeyPlugin } from "../types/auth-core-types";
import useAuthMutation from "./shared/use-auth-mutation";
import useAuthQuery from "./shared/use-auth-query";

// Passkey Deletion Hook
export const useDeletePasskey = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listPasskeysKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: (authClient as unknown as AuthClientWithPasskeyPlugin).passkey.deletePasskey,
        options,
        queryKey,
    });
};

// Passkey Listing Hook
export const useListPasskeys = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listPasskeysKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({
        authClient,
        options,
        queryFn: (authClient as unknown as AuthClientWithPasskeyPlugin).passkey.listUserPasskeys,
        queryKey,
    });
};
