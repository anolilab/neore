import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { BetterFetchOption } from "better-auth/react";
import { use } from "react";

import type { AuthQueryOptions } from "../../lib/auth-query-provider";
import { AuthQueryContext } from "../../lib/auth-query-provider";
import type { NonThrowableResult, ThrowableResult } from "../../types/auth-core-types";
import useOnMutateError from "./use-mutate-error";

type AuthMutationFunction<TParameters> = (parameters: TParameters) => Promise<ThrowableResult<any> | NonThrowableResult<any>>;

const useAuthMutation = <TAuthFunction extends AuthMutationFunction<any>>({
    mutationFn,
    optimisticData,
    options,
    queryKey,
}: {
    mutationFn: TAuthFunction;
    optimisticData?: (parameters: Omit<Parameters<TAuthFunction>[0], "fetchOptions">, previousData: unknown) => unknown;
    options?: Partial<AuthQueryOptions>;
    queryKey: QueryKey;
}) => {
    type TParameters = Parameters<TAuthFunction>[0];
    const queryClient = useQueryClient();
    const context = use(AuthQueryContext);
    const { optimistic } = { ...context, ...options };
    const { onMutateError } = useOnMutateError();

    const mutation = useMutation({
        mutationFn: ({ fetchOptions = { throw: true }, ...parameters }: TParameters) => mutationFn({ fetchOptions, ...parameters }),
        onMutate: async (params: TParameters) => {
            if (!optimistic || !optimisticData) return undefined;

            await queryClient.cancelQueries({ queryKey });

            const previousData = queryClient.getQueryData(queryKey);

            if (!previousData) return undefined;

            queryClient.setQueryData(queryKey, () => optimisticData(params, previousData));

            return { previousData };
        },
        onError: (error, _, mutationContext) => onMutateError(error, queryKey, mutationContext),
        onSettled: () => queryClient.invalidateQueries({ queryKey }),
    });

    const { error, isPending, mutate } = mutation;

    async function mutateAsync(parameters: Omit<TParameters, "fetchOptions"> & { fetchOptions?: { throw?: true } }): Promise<ThrowableResult<any>>;

    async function mutateAsync(parameters: Omit<TParameters, "fetchOptions"> & { fetchOptions?: BetterFetchOption }): Promise<NonThrowableResult<any>>;

    async function mutateAsync(parameters: TParameters): Promise<ThrowableResult<any> | NonThrowableResult<any>> {
        return await mutation.mutateAsync(parameters);
    }

    return {
        ...mutation,
        error,
        isPending,
        mutate,
        mutateAsync,
    };
};

export default useAuthMutation;
