import { api } from "@neore/backend/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { useAction } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";
import { DEVELOP_QUERY_ROOT, useDevelopUser } from "./use-develop";

/** Codes a server action throws before any host call: nothing reached the host, so nothing changed. */
const PRE_HOST_CODES = new Set(["BAD_REQUEST", "FORBIDDEN", "TOO_MANY_REQUESTS", "UNAUTHORIZED"]);

/** A thrown error the server raised before it called the host. Any other error may come after the host acted. */
export const isPreHostRefusal = (error: unknown): boolean =>
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" && PRE_HOST_CODES.has(error.code);

/** Only an answer that the host may have acted on (taken, or unconfirmed) and an error after a host call change what is cached. */
const mayHaveChanged = (outcome: { status: string } | undefined, error: unknown): boolean =>
    error === null ? outcome?.status === "ok" || outcome?.status === "unconfirmed" : !isPreHostRefusal(error);

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
    // A refusal or a pre-host error changed nothing, so it does not spend host reads on a refresh.
    const refreshIfChanged = async (outcome: { status: string } | undefined, error: unknown) => {
        if (mayHaveChanged(outcome, error)) {
            await refresh();
        }
    };

    return {
        edit: useMutation({
            networkMode: "always",
            retry: 0,
            mutationFn: async (input: { body?: string; title?: string }) => await edit({ ...address, ...input }),
            onSettled: refreshIfChanged,
        }),
        requestReviewers: useMutation({
            networkMode: "always",
            retry: 0,
            mutationFn: async (logins: string[]) => await requestReviewers({ ...address, logins }),
            onSettled: refreshIfChanged,
        }),
        revert: useMutation({
            networkMode: "always",
            retry: 0,
            mutationFn: async () => await revert({ ...address }),
            // A revert is a new pull request: the page of this one changes only when the host says so, so refresh it too.
            onSettled: refreshIfChanged,
        }),
    };
};
