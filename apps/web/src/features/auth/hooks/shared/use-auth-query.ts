import type { QueryKey } from "@tanstack/query-core";
import { skipToken } from "@tanstack/query-core";
import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import type { BetterFetchOption, BetterFetchResponse } from "better-auth/react";
import { use } from "react";

import { AuthQueryContext } from "../../lib/auth-query-provider";
import type { AnyAuthClient } from "../../types/auth-core-types";
import { useSession } from "../session-user-management";

export type BetterFetchRequest<TData> = ({ fetchOptions }: { fetchOptions: BetterFetchOption }) => Promise<BetterFetchResponse<TData>>;

type UseAuthQueryProperties<TData, TAuthClient> = {
    authClient: TAuthClient;
    options?: Partial<AnyUseQueryOptions>;
    queryFn: BetterFetchRequest<TData>;
    queryKey: QueryKey;
};

const useAuthQuery = <TData, TAuthClient extends AnyAuthClient = AnyAuthClient>({
    authClient,
    options,
    queryFn,
    queryKey,
}: UseAuthQueryProperties<TData, TAuthClient>) => {
    const { data: sessionData } = useSession(authClient);
    const { queryOptions } = use(AuthQueryContext);
    const mergedOptions = { ...queryOptions, ...options };

    return useQuery<TData>({
        queryFn: sessionData ? () => queryFn({ fetchOptions: { throw: true } }) : skipToken,
        queryKey,
        ...mergedOptions,
    });
};

export default useAuthQuery;
