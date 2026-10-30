import { api } from "@neore/backend/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { createLunoraActionQueryOptions, useAction, useLunora } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";
import { DEVELOP_QUERY_ROOT, READ, useDevelopUser } from "./use-develop";

const MINUTE_MS = 60_000;

/** The methods, auto-merge setting and mergeability the host reports; read once the merge panel is on screen. */
export const useMergeStatus = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.merge_functions.getMergeStatus, address as PullRequestAddress);

    return useQuery({
        ...READ,
        ...options,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryKey: [DEVELOP_QUERY_ROOT, userId, "merge", address],
        staleTime: MINUTE_MS,
    });
};

/** The writes of the checks and merge UI. Each runs only from a confirmed dialog, and refreshes what it changed. */
export const useChecksAndMergeActions = (address: PullRequestAddress) => {
    const queryClient = useQueryClient();
    const userId = useDevelopUser();
    const rerun = useAction(api.source_control.merge_functions.rerunCheck);
    const merge = useAction(api.source_control.merge_functions.mergePullRequest);
    const setAutoMerge = useAction(api.source_control.merge_functions.setAutoMerge);
    const refresh = async (...kinds: string[]) =>
        await Promise.all(kinds.map(async (kind) => await queryClient.invalidateQueries({ queryKey: [DEVELOP_QUERY_ROOT, userId, kind, address] })));

    return {
        autoMerge: useMutation({
            mutationFn: async (input: { enabled: boolean; method: "merge" | "rebase" | "squash" }) => await setAutoMerge({ ...address, ...input }),
            onSettled: async () => await refresh("merge"),
        }),
        merge: useMutation({
            mutationFn: async (input: { headSha: string; method: "merge" | "rebase" | "squash" }) => await merge({ ...address, ...input }),
            // A merge the host may have taken is refreshed too: the page then shows what the host says.
            onSettled: async () => await refresh("pull", "merge", "checks"),
        }),
        rerun: useMutation({
            mutationFn: async (checkId: string) => await rerun({ ...address, checkId }),
            onSettled: async () => await refresh("checks"),
        }),
    };
};
