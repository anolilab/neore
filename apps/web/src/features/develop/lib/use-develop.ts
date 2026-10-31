import { api } from "@neore/backend/api";
import type { InboxSection } from "@neore/backend/source-control/types";
import { LIVE_META_KEY } from "@neore/client-runtime";
import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { createLunoraActionQueryOptions, useAction, useCRPC, useLunora } from "@/lib/lunora/crpc";

import { retryFailedPage } from "./failed-pages";

const MINUTE_MS = 60_000;

/** Every Develop query key starts with this, so disconnecting a host can drop what it left in the cache in one call. */
export const DEVELOP_QUERY_ROOT = "develop";

/**
 * Reads from the host cost API budget and never change under a subscription: cache a little, never go live, and
 * do not refetch on window focus, which would re-read every loaded page of a long list one after another.
 */
export const READ = { meta: { [LIVE_META_KEY]: false }, refetchOnWindowFocus: false, retry: false };

export interface PullRequestAddress {
    number: number;
    repository: string;
}

/**
 * The signed-in user's id. Every read here is private to that account, so it is part of each
 * cache key and nothing is fetched before it is known: another account on the same browser
 * can never be handed the previous one's results.
 */
export const useDevelopUser = (): string | undefined => {
    const { hooks } = useAuth();

    return hooks.useSession().data?.user.id;
};

/** Which host Develop reads, what it can do, and whether it is connected. Fetched once the page opens. */
export const useDevelopHost = () => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.functions.getDevelopHost, {});

    return useQuery({ ...READ, ...options, enabled: userId !== undefined, queryKey: [DEVELOP_QUERY_ROOT, userId, "host"], staleTime: 5 * MINUTE_MS });
};

export const useInbox = (section: InboxSection | undefined) => {
    const getInbox = useAction(api.source_control.functions.getInbox);
    const userId = useDevelopUser();

    return useInfiniteQuery({
        ...READ,
        enabled: section !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }: { pageParam: number }) => await getInbox({ page: pageParam, section: section as InboxSection }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getInbox>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: [DEVELOP_QUERY_ROOT, userId, "inbox", section],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequest = (address: PullRequestAddress | undefined) => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.functions.getPullRequest, address as PullRequestAddress);

    return useQuery({
        ...READ,
        ...options,
        enabled: address !== undefined && userId !== undefined,
        queryKey: [DEVELOP_QUERY_ROOT, userId, "pull", address],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestCommits = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getCommits = useAction(api.source_control.functions.getPullRequestCommits);
    const userId = useDevelopUser();

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }: { pageParam: number }) => await getCommits({ ...(address as PullRequestAddress), page: pageParam }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getCommits>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: [DEVELOP_QUERY_ROOT, userId, "commits", address],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestFiles = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getFiles = useAction(api.source_control.functions.getPullRequestFiles);
    const queryClient = useQueryClient();
    const userId = useDevelopUser();
    const queryKey = [DEVELOP_QUERY_ROOT, userId, "files", address];
    const query = useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }: { pageParam: number }) => await getFiles({ ...(address as PullRequestAddress), page: pageParam }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getFiles>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey,
        staleTime: MINUTE_MS,
    });

    return {
        ...query,
        /** Asks the host again for the page that failed (and lets the ones after it load), not for the pages already read. */
        retry: async () => await retryFailedPage(queryClient, queryKey, query.fetchNextPage),
    };
};

export const usePullRequestChecks = (address: PullRequestAddress | undefined, headSha: string | undefined, enabled: boolean) => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.functions.getPullRequestChecks, {
        ...(address as PullRequestAddress),
        headSha: headSha as string,
    });

    return useQuery({
        ...READ,
        ...options,
        enabled: enabled && address !== undefined && headSha !== undefined && userId !== undefined,
        queryKey: [DEVELOP_QUERY_ROOT, userId, "checks", address, headSha],
        staleTime: MINUTE_MS,
    });
};

/**
 * The threads working on one pull request: the one started from here and the ones a coding agent opened it from. Our
 * own rows, not the host's, so this one is live — a run that opens a pull request shows up while the page is open.
 */
export const usePullRequestThreads = (address: PullRequestAddress | undefined) => {
    const crpc = useCRPC();

    return useQuery(crpc.source_control.pr_threads.listForPullRequest.queryOptions(address ?? skipToken));
};

/** Work on this PR: opens a thread with the pull request attached, or names the thread already working on it. */
export const useStartWorkOnPullRequest = () => {
    const crpc = useCRPC();

    return useMutation(crpc.source_control.pr_threads.startWorkOnPullRequest.mutationOptions());
};

/** The pull request a thread was attached to or opened, for the thread's own header. */
export const useThreadPullRequest = (threadId: string | undefined) => {
    const crpc = useCRPC();

    return useQuery(crpc.source_control.pr_threads.getForThread.queryOptions(threadId === undefined ? skipToken : { threadId }));
};
