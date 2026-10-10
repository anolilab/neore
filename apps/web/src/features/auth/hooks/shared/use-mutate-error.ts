import type { Query, QueryKey } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { use } from "react";

import { AuthQueryContext } from "../../lib/auth-query-provider";

const useOnMutateError = () => {
    const queryClient = useQueryClient();
    const { optimistic } = use(AuthQueryContext);

    const onMutateError = (error: Error, queryKey: QueryKey, context?: { previousData?: unknown }) => {
        if (error) {
            console.error(error);
            queryClient.getQueryCache().config.onError?.(error, { queryKey } as unknown as Query<unknown, unknown>);
        }

        if (!optimistic || !context?.previousData) {
            return;
        }

        queryClient.setQueryData(queryKey, context.previousData);
    };

    return { onMutateError };
};

export default useOnMutateError;
