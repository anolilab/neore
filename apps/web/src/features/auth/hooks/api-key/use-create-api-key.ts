import { use } from "react";

import type { AuthQueryOptions } from "../../lib/auth-query-provider";
import { AuthQueryContext } from "../../lib/auth-query-provider";
import type { AnyAuthClient } from "../../types/auth-core-types";
import useAuthMutation from "../shared/use-auth-mutation";

type AuthMutationFunction = (parameters: Record<string, unknown>) => Promise<unknown>;

type AnyAuthClientWithApiKey = AnyAuthClient & {
    apiKey: {
        create: AuthMutationFunction;
    };
};

const useCreateApiKey = <TAuthClient extends AnyAuthClient>(authClient: TAuthClient, options?: Partial<AuthQueryOptions>) => {
    const { listApiKeysKey: queryKey } = use(AuthQueryContext);

    return useAuthMutation({
        mutationFn: (authClient as unknown as AnyAuthClientWithApiKey).apiKey.create,
        options,
        queryKey,
    });
};

export default useCreateApiKey;
