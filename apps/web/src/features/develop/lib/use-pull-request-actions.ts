import { api } from "@neore/backend/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAction } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";
import { DEVELOP_QUERY_ROOT, useDevelopUser } from "./use-develop";

/** The writes of the pull request actions panel. Each runs only from a confirmed dialog and refreshes what it changed. */
export const usePullRequestActions = (address: PullRequestAddress) => {
    const queryClient = useQueryClient();
    const userId = useDevelopUser();
    const edit = useAction(api.source_control.pull_request_actions.editPullRequest);
    const requestReviewers = useAction(api.source_control.pull_request_actions.requestReviewers);
    const revert = useAction(api.source_control.pull_request_actions.revertPullRequest);
    // The open pull request and the inbox rows of this account both show titles and the list of open requests.
    const refresh = async () =>
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: [DEVELOP_QUERY_ROOT, userId, "pull", address] }),
            queryClient.invalidateQueries({ queryKey: [DEVELOP_QUERY_ROOT, userId, "inbox"] }),
        ]);

    return {
        edit: useMutation({
            mutationFn: async (input: { body?: string; title?: string }) => await edit({ ...address, ...input }),
            onSettled: refresh,
        }),
        requestReviewers: useMutation({
            mutationFn: async (logins: string[]) => await requestReviewers({ ...address, logins }),
            onSettled: refresh,
        }),
        revert: useMutation({
            mutationFn: async () => await revert({ ...address }),
            // A revert is a new pull request: the page of this one changes only when the host says so, so refresh it too.
            onSettled: refresh,
        }),
    };
};
