"use client";

import type { ReturnOf } from "@lunora/react";
import type { api } from "@neore/backend/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useCRPC } from "@/lib/lunora/crpc";

/** The row shape `auth_functions.getUserSettings` returns — used to type the optimistic rollback. */
type UserSettingsRow = ReturnOf<typeof api.auth.functions.getUserSettings>;

/**
 * Hook to get user settings for the current user.
 */
export const useUserSettings = () => {
    const crpc = useCRPC();

    return useQuery(crpc.auth.functions.getUserSettings.queryOptions({}));
};

/**
 * Hook to update user settings with optimistic updates.
 */
export const useUpdateUserSettings = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const queryOptions = crpc.auth.functions.getUserSettings.queryOptions({});

    return useMutation({
        ...crpc.auth.functions.updateUserSettings.mutationOptions(),
        onMutate: async (args) => {
            // Cancel any outgoing refetches
            await queryClient.cancelQueries({ queryKey: queryOptions.queryKey });

            // Snapshot the previous value
            const previousSettings = queryClient.getQueryData<UserSettingsRow>(queryOptions.queryKey);

            // Optimistically update to the new value
            if (previousSettings !== undefined) {
                queryClient.setQueryData(queryOptions.queryKey, {
                    ...previousSettings,
                    ...args,
                });
            }

            // Return a context object with the snapshotted value
            return { previousSettings };
        },
        onError: (_error, _args, context: { previousSettings?: UserSettingsRow } | undefined) => {
            // If the mutation fails, use the context returned from onMutate to roll back
            if (context?.previousSettings) {
                queryClient.setQueryData(queryOptions.queryKey, context.previousSettings);
            }
        },
        // The optimistic write above only lands when the settings query had
        // already resolved; otherwise the cache kept the pre-mutation row and a
        // setting read from it (e.g. `onboardingCompleted` behind "Skip tour")
        // never changed on screen. Re-read the server's row either way.
        onSettled: async () => {
            await queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
        },
    });
};
