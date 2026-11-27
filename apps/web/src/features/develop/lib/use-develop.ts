import { api } from "@neore/backend/api";
import type { InboxSection } from "@neore/backend/source-control/types";
import { LIVE_META_KEY } from "@neore/client-runtime";
import { keepPreviousData, skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { createLunoraActionQueryOptions, useAction, useCRPC, useLunora } from "@/lib/lunora/crpc";

import { retryFailedPage } from "./failed-pages";
import { nextMergeReread } from "./merge-reread";

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
export const useDevelopUser = (): string | undefined => useAuthSession().data?.user.id;

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
 * How far a pull request's head commit is behind its base branch, from the host comparing the two. Keyed by the base branch
 * and the head commit, so a push or a retarget reads again instead of answering from another revision's cache.
 */
export const useBranchComparison = (address: PullRequestAddress | undefined, revision: { baseBranch: string; headSha: string } | undefined) => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.functions.getBranchComparison, {
        ...(address as PullRequestAddress),
        ...(revision as { baseBranch: string; headSha: string }),
    });

    return useQuery({
        ...READ,
        ...options,
        enabled: address !== undefined && revision !== undefined && userId !== undefined,
        queryKey: [DEVELOP_QUERY_ROOT, userId, "compare", address, revision?.baseBranch, revision?.headSha],
        staleTime: MINUTE_MS,
    });
};

/** When each status read first answered "unknown" in a row; a known answer ends the row, so a later push starts a new one. */
const mergeUnknownSince = new WeakMap<object, number>();

/**
 * What stands between one linked pull request and its merge (failing checks, a conflict, requested changes), for the
 * chat header. Keyed by account and pull request, so every thread linked to it shares one read; a few minutes stale,
 * never live and never on focus, so showing a thread does not cost a host call per render. While the host still works
 * out whether it merges cleanly, it is read again shortly, a few times, so a conflict found then shows up.
 */
export const usePullRequestStatus = (address: PullRequestAddress | undefined, viewingThreadId?: string, read = true) => {
    const client = useLunora();
    const userId = useDevelopUser();
    // The chat whose header asks: the server stamps that chat's own link as read, and only a chat's header passes it.
    const args = address === undefined ? undefined : { ...address, ...(viewingThreadId !== undefined && { threadId: viewingThreadId }) };
    const options = createLunoraActionQueryOptions(client, api.source_control.pr_status.getPullRequestStatus, args as PullRequestAddress);

    return useQuery({
        ...READ,
        ...options,
        // A link this view does not read keeps whatever status it already has, and asks the host for nothing.
        enabled: address !== undefined && userId !== undefined && read,
        queryKey: [DEVELOP_QUERY_ROOT, userId, "status", address, viewingThreadId],
        refetchInterval: (query) => {
            const { delay, since } = nextMergeReread(query.state.data, mergeUnknownSince.get(query), Date.now(), query.state.status === "error");

            if (since === undefined) {
                mergeUnknownSince.delete(query);
            } else {
                mergeUnknownSince.set(query, since);
            }

            return delay;
        },
        staleTime: 5 * MINUTE_MS,
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

/** Every pull request a thread is linked to, for the thread's own header. Live: a link made elsewhere shows up here too. */
export const useThreadPullRequests = (threadId: string | undefined) => {
    const crpc = useCRPC();

    return useQuery(crpc.source_control.pr_thread_attach.listForThread.queryOptions(threadId === undefined ? skipToken : { threadId }));
};

/** Attaches existing pull requests to a thread by hand. The host reads each one first; a refusal is reported per pull request. */
export const useAttachPullRequests = () => useAction(api.source_control.pr_thread_attach.attachPullRequests);

/** Threads one count read asks for: the backend's own cap. The rows past it show no badge. */
const MAX_COUNT_THREADS = 200;

/**
 * How many pull requests each of the given threads is linked to, read ONCE for a whole list (the sidebar), not per
 * row. The first 200 in list order are kept, then sorted so the query keeps one identity while the list only reorders,
 * and nothing is asked until
 * the page has painted, so the sidebar does not add to the queries the first paint waits for.
 */
export const usePullRequestCounts = (threadIds: ReadonlyArray<string>, ready: boolean): ReadonlyMap<string, number> => {
    const crpc = useCRPC();
    const sorted = useMemo(() => [...new Set(threadIds)].slice(0, MAX_COUNT_THREADS).toSorted((left, right) => left.localeCompare(right)), [threadIds]);
    const { data } = useQuery({
        ...crpc.source_control.pr_thread_attach.countsForThreads.queryOptions(ready && sorted.length > 0 ? { threadIds: sorted } : skipToken),
        // The visible set changes as groups open and threads come and go: the last counts stay until the new ones arrive.
        placeholderData: keepPreviousData,
    });

    return useMemo(() => new Map((data ?? []).map((row) => [row.threadId, row.count])), [data]);
};
