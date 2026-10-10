import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use } from "react";

import type { AuthClient } from "@/lib/auth/client";

import type { AuthQueryOptions } from "../lib/auth-query-provider";
import { AuthQueryContext } from "../lib/auth-query-provider";
import useAuthMutation from "./shared/use-auth-mutation";
import useAuthQuery from "./shared/use-auth-query";

// Account Listing Hook
export const useListAccounts = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listAccountsKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({
        authClient,
        options,
        queryFn: authClient.listAccounts,
        queryKey,
    });
};

// Account Unlinking Hook
export const useUnlinkAccount = <TAuthClient extends AuthClient>(authClient: TAuthClient, options?: AuthQueryOptions) => {
    const { listAccountsKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: authClient.unlinkAccount,
        options,
        queryKey,
    });
};
