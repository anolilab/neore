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
 * The settings writes `updateLatest` has queued in this tab. Each waits for the one before it;
 * `pending` counts the ones not yet finished.
 */
const settingsWrites = { pending: 0, tail: Promise.resolve() as Promise<unknown> };

/**
 * Hook to update user settings with optimistic updates.
 *
 * `updateLatest` is for a patch that depends on the current value (a list reorder, a map entry):
 * it is built from the cache when its turn comes, so two quick edits cannot overwrite each other.
 */
export const useUpdateUserSettings = () => {
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const queryOptions = crpc.auth.functions.getUserSettings.queryOptions({});

    const mutation = useMutation({
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
            // A queued write is still behind this one: a refetch now would bring back the server row and hide the edits queued after it.
            if (settingsWrites.pending > 0) {
                return;
            }

            await queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
        },
    });

    type Patch = Parameters<typeof mutation.mutateAsync>[0];

    /**
     * Applies `build` to the cached settings at once, so the UI updates now, then queues the write.
     * When its turn comes the write sends the fields' values as the cache holds them then, which
     * include every edit queued before it. A patch that depends on the current value (a list
     * reorder, a map entry) therefore never overwrites another edit made meanwhile.
     */
    const updateLatest = (build: (current: UserSettingsRow | undefined) => Patch) => {
        const before = queryClient.getQueryData<UserSettingsRow>(queryOptions.queryKey);
        const patch = build(before);
        const fields = Object.keys(patch) as (keyof UserSettingsRow)[];

        if (before !== undefined) {
            queryClient.setQueryData(queryOptions.queryKey, { ...before, ...patch });
        }

        settingsWrites.pending += 1;

        const run = settingsWrites.tail.then(() => {
            const latest = queryClient.getQueryData<UserSettingsRow>(queryOptions.queryKey);
            const body = latest ? Object.fromEntries(fields.map((field) => [field, latest[field]])) : patch;

            return mutation.mutateAsync(body as Patch);
        });

        // The catch keeps a failed write from stalling the queue and marks `run` handled (`mutate` swallows errors too).
        // The last write to finish refetches after a failure, so the cache matches the server again.
        settingsWrites.tail = run
            .catch(() => {
                if (settingsWrites.pending === 1) {
                    void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
                }
            })
            .finally(() => {
                settingsWrites.pending -= 1;
            });
    };

    return { ...mutation, updateLatest };
};
