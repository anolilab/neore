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
            // If the mutation fails, use the context returned from onMutate to roll back. Not while a queued write is behind
            // this one: the snapshot predates the edits it queued, so restoring it would drop them. The last write to settle refetches.
            if (settingsWrites.pending <= 1 && context?.previousSettings) {
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
    const updateLatest = (build: (current: UserSettingsRow | undefined) => Patch): Promise<void> => {
        const before = queryClient.getQueryData<UserSettingsRow>(queryOptions.queryKey);
        const patch = build(before);
        const fields = Object.keys(patch) as (keyof UserSettingsRow)[];
        // Whose settings this edit was made on. The row carries the owner; a brand-new account has none yet, so the cache entry
        // itself stands in: a sign-in clears the cache, and the entry that is rebuilt afterwards is a different object.
        const owner = before?.userId;
        const cacheEntry = queryClient.getQueryCache().find({ exact: true, queryKey: queryOptions.queryKey });

        if (before !== undefined) {
            queryClient.setQueryData(queryOptions.queryKey, { ...before, ...patch });
        }

        settingsWrites.pending += 1;

        const run = settingsWrites.tail.then(() => {
            const latest = queryClient.getQueryData<UserSettingsRow>(queryOptions.queryKey);

            // The account changed while this write waited (sign-in over a guest clears the cache): sending it now would store
            // the old account's edit on the new one. The caller sees a failed save.
            const entryNow = queryClient.getQueryCache().find({ exact: true, queryKey: queryOptions.queryKey });

            if ((owner !== undefined && latest?.userId !== owner) || (cacheEntry !== undefined && entryNow !== cacheEntry)) {
                throw new Error("The signed-in account changed before this setting was saved.");
            }

            const body = latest ? Object.fromEntries(fields.map((field) => [field, latest[field]])) : patch;

            return mutation.mutateAsync(body as Patch);
        });

        // The catch keeps a failed write from stalling the queue and marks `run` handled (`mutate` swallows errors too).
        // The last write to settle refetches, after a success or a failure alike, so the cache matches the server again.
        settingsWrites.tail = run
            .catch(() => {
                // Handled by onError; the refetch below covers it.
            })
            .finally(() => {
                settingsWrites.pending -= 1;

                if (settingsWrites.pending === 0) {
                    void queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
                }
            });

        // The returned promise rejects when this write fails, so a caller that awaits it can report the rollback.
        // Callers that ignore it are already covered by onError, so the rejection is marked handled here.
        const outcome = run.then(() => undefined);

        outcome.catch(() => {
            // Handled by onError; a caller that awaits the result still sees the rejection.
        });

        return outcome;
    };

    return { ...mutation, updateLatest };
};
