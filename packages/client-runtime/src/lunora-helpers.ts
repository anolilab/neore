/**
 * The Lunora react helpers `crpc` re-exports: invoke an action, read auth state,
 * and build query options for route loaders. Generic over the function reference,
 * so none of them needs the generated `api` (that lives in the web app's `crpc.tsx`).
 */
import type { ArgsOf, FunctionReference, LunoraClient, ReturnOf } from "@lunora/react";
import { lunoraQueryOptions, useAuthState, useLunora } from "@lunora/react";
import type { UseMutationOptions } from "@tanstack/react-query";
import { useMemo } from "react";

import { shardOptionsFor } from "./shard-routing";
import { withUnlockProof } from "./unlock-proofs";

/**
 * One action call, for both hooks: a locked chat's args carry its in-memory
 * proof (`unlock-proofs.ts`), and the call goes to the chat owner's shard.
 */
export const runLunoraAction = async (client: LunoraClient, reference: FunctionReference, args: unknown): Promise<unknown> =>
    await client.action(reference as never, withUnlockProof(args) as never, shardOptionsFor(args));

/**
 * `useAction(ref)` — Lunora action invocation hook.
 */
export const useAction = <F extends FunctionReference>(reference: F): ((args: ArgsOf<F>) => Promise<ReturnOf<F>>) => {
    const client = useLunora();

    return useMemo(() => async (args: ArgsOf<F>) => (await runLunoraAction(client, reference, args)) as ReturnOf<F>, [client, reference]);
};

/**
 * `useLunoraActionOptions(ref)` — TanStack mutation options that invoke a Lunora action.
 */
export const useLunoraActionOptions = <F extends FunctionReference>(reference: F): UseMutationOptions<ReturnOf<F>, Error, ArgsOf<F>> => {
    const client = useLunora();

    return useMemo(() => {
        return { mutationFn: async (args: ArgsOf<F>) => (await runLunoraAction(client, reference, args)) as ReturnOf<F> };
    }, [client, reference]);
};

/**
 * `useLunoraAuth()` — Lunora's `{ isAuthenticated, isLoading }`.
 */
export const useLunoraAuth = (): { isAuthenticated: boolean; isLoading: boolean } => {
    const state = useAuthState();

    return { isAuthenticated: state.isAuthenticated, isLoading: state.isLoading };
};

/**
 * `createLunoraQueryOptions(client, ref, args)` — query options for route loaders.
 */
export const createLunoraQueryOptions = <F extends FunctionReference>(client: LunoraClient, reference: F, args: ArgsOf<F>) =>
    lunoraQueryOptions(client, reference, withUnlockProof(args) as ArgsOf<F>, shardOptionsFor(args));

/**
 * Query options whose fetch is a Lunora ACTION — for reads that must run as an
 * action, like the anonymous share pages (`getPublicThread`, `getPublicPage`,
 * `getPublicWorkflow`): the row lives on its owner's shard, and only the server
 * may hop there. Never live; an action has no subscription.
 */
export const createLunoraActionQueryOptions = <F extends FunctionReference>(client: LunoraClient, reference: F, args: ArgsOf<F>) => {
    return {
        queryFn: async (): Promise<ReturnOf<F>> => await client.action(reference as never, args as never),
        queryKey: ["lunora-action", (reference as unknown as { __lunoraRef: string }).__lunoraRef, args] as const,
    };
};
