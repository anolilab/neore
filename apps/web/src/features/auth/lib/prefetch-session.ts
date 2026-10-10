import type { AnyUseQueryOptions, QueryClient } from "@tanstack/react-query";

import type { AuthClient } from "@/lib/auth/client";

import type { AnyAuthClient } from "../types/auth-core-types";
import type { AuthQueryOptions } from "./auth-query-provider";

export default async function prefetchSession<TAuthClient extends AnyAuthClient>(
    authClient: TAuthClient,
    queryClient: QueryClient,
    queryOptions?: AuthQueryOptions,
    options?: Partial<AnyUseQueryOptions>,
) {
    const { data, error } = await (authClient as AuthClient).getSession();

    const mergedOptions = {
        ...queryOptions?.queryOptions,
        ...queryOptions?.sessionQueryOptions,
        ...options,
    };

    await queryClient.prefetchQuery({
        ...mergedOptions,
        queryFn: () => data as SessionData,
        queryKey: queryOptions?.sessionKey,
    });

    type SessionData = TAuthClient["$Infer"]["Session"];
    type User = TAuthClient["$Infer"]["Session"]["user"];
    type Session = TAuthClient["$Infer"]["Session"]["session"];

    return {
        data,
        error,
        session: data?.session as Session | undefined,
        user: data?.user as User | undefined,
    };
}
