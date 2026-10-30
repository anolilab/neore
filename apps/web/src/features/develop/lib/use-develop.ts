import { api } from "@neore/backend/api";
import type { InboxSection } from "@neore/backend/source-control/types";
import { LIVE_META_KEY } from "@neore/client-runtime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { createLunoraActionQueryOptions, useAction, useLunora } from "@/lib/lunora/crpc";

const MINUTE_MS = 60_000;

/** Reads from the host cost API budget and never change under a subscription: cache a little, never go live. */
const READ = { meta: { [LIVE_META_KEY]: false }, retry: false };

export interface PullRequestAddress {
    number: number;
    repository: string;
}

/** Which host Develop reads, what it can do, and whether it is connected. Fetched once the page opens. */
export const useDevelopHost = () => {
    const client = useLunora();

    return useQuery({ ...READ, ...createLunoraActionQueryOptions(client, api.source_control.functions.getDevelopHost, {}), staleTime: 5 * MINUTE_MS });
};

export const useInbox = (section: InboxSection | undefined) => {
    const getInbox = useAction(api.source_control.functions.getInbox);

    return useInfiniteQuery({
        ...READ,
        enabled: section !== undefined,
        queryFn: async ({ pageParam }) => await getInbox({ page: pageParam, section: section as InboxSection }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getInbox>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: ["develop", "inbox", section],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequest = (address: PullRequestAddress | undefined) => {
    const client = useLunora();

    return useQuery({
        ...READ,
        ...createLunoraActionQueryOptions(client, api.source_control.functions.getPullRequest, address as PullRequestAddress),
        enabled: address !== undefined,
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestCommits = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getCommits = useAction(api.source_control.functions.getPullRequestCommits);

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined,
        queryFn: async ({ pageParam }) => await getCommits({ ...(address as PullRequestAddress), page: pageParam }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getCommits>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: ["develop", "commits", address],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestFiles = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getFiles = useAction(api.source_control.functions.getPullRequestFiles);

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined,
        queryFn: async ({ pageParam }) => await getFiles({ ...(address as PullRequestAddress), page: pageParam }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getFiles>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: ["develop", "files", address],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestChecks = (address: PullRequestAddress | undefined, headSha: string | undefined, enabled: boolean) => {
    const client = useLunora();

    return useQuery({
        ...READ,
        ...createLunoraActionQueryOptions(client, api.source_control.functions.getPullRequestChecks, {
            ...(address as PullRequestAddress),
            headSha: headSha as string,
        }),
        enabled: enabled && address !== undefined && headSha !== undefined,
        staleTime: MINUTE_MS,
    });
};
