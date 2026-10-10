import type { AnyUseQueryOptions } from "@tanstack/react-query";
import { use } from "react";

import { AuthQueryContext } from "../../lib/auth-query-provider";
import type { AnyAuthClient } from "../../types/auth-core-types";
import type { BetterFetchRequest } from "../shared/use-auth-query";
import useAuthQuery from "../shared/use-auth-query";

type AnyAuthClientWithApiKey = AnyAuthClient & {
    apiKey: {
        list: BetterFetchRequest<unknown>;
    };
};

const useListApiKeys = <TAuthClient extends AnyAuthClient>(authClient: TAuthClient, options?: Partial<AnyUseQueryOptions>) => {
    const { listApiKeysKey: queryKey } = use(AuthQueryContext);

    return useAuthQuery({
        authClient,
        options,
        queryFn: (authClient as unknown as AnyAuthClientWithApiKey).apiKey.list,
        queryKey,
    });
};

export default useListApiKeys;
