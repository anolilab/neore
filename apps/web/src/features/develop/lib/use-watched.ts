import { api } from "@neore/backend/api";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

import { useDevelopUser } from "./use-develop";

/** The caller's watched repositories with their cached lists. Live: a poll on the shard shows without a refetch. */
export const useWatchedRepositories = (enabled: boolean) => {
    const crpc = useCRPC();
    const userId = useDevelopUser();
    const options = crpc.source_control.freshness.listWatchedRepositories.queryOptions({});

    return useQuery({ ...options, enabled: enabled && userId !== undefined });
};

export const useWatchMutations = () => {
    const crpc = useCRPC();

    return {
        disableWebhook: useMutation(crpc.source_control.freshness.disableWatchWebhook.mutationOptions()),
        enableWebhook: useMutation(crpc.source_control.freshness.enableWatchWebhook.mutationOptions()),
        unwatch: useMutation(crpc.source_control.freshness.unwatchRepo.mutationOptions()),
        watch: useMutation(crpc.source_control.freshness.watchRepo.mutationOptions()),
    };
};

/**
 * Asks the backend to read the watched repositories again when Develop opens (a 304 per unchanged repository).
 * Once per mount; the live list shows what it found. Not on `/chat`: only the Develop route mounts this.
 */
export const useRefreshWatchedOnOpen = (enabled: boolean): void => {
    const refresh = useAction(api.source_control.freshness.refreshWatchedRepositories);
    const done = useRef(false);

    useEffect(() => {
        if (!enabled || done.current) {
            return;
        }

        done.current = true;
        // A failed refresh is not an error to show: the tick polls anyway, and the list says when it last looked.
        refresh({}).catch(() => undefined);
    }, [enabled, refresh]);
};
