import { api } from "@neore/backend/api";
import type { InboxSection } from "@neore/backend/source-control/types";
import { LIVE_META_KEY } from "@neore/client-runtime";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { createLunoraActionQueryOptions, useAction, useLunora } from "@/lib/lunora/crpc";

const MINUTE_MS = 60_000;

/** Reads from the host cost API budget and never change under a subscription: cache a little, never go live. */
const READ = { meta: { [LIVE_META_KEY]: false }, retry: false };

export interface PullRequestAddress {
    number: number;
    repository: string;
}

/**
 * The signed-in user's id. Every read here is private to that account, so it is part of each
 * cache key and nothing is fetched before it is known: another account on the same browser
 * can never be handed the previous one's results.
 */
const useDevelopUser = (): string | undefined => {
    const { hooks } = useAuth();

    return hooks.useSession().data?.user.id;
};

/** Which host Develop reads, what it can do, and whether it is connected. Fetched once the page opens. */
export const useDevelopHost = () => {
    const client = useLunora();
    const userId = useDevelopUser();
    const options = createLunoraActionQueryOptions(client, api.source_control.functions.getDevelopHost, {});

    return useQuery({ ...READ, ...options, enabled: userId !== undefined, queryKey: [...options.queryKey, userId], staleTime: 5 * MINUTE_MS });
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
        queryKey: ["develop", userId, "inbox", section],
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
        queryKey: [...options.queryKey, userId],
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
        queryKey: ["develop", userId, "commits", address],
        staleTime: MINUTE_MS,
    });
};

export const usePullRequestFiles = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getFiles = useAction(api.source_control.functions.getPullRequestFiles);
    const userId = useDevelopUser();

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }: { pageParam: number }) => await getFiles({ ...(address as PullRequestAddress), page: pageParam }),
        initialPageParam: 1,
        getNextPageParam: (last: Awaited<ReturnType<typeof getFiles>>) => (last.status === "ok" && last.hasMore ? last.page + 1 : undefined),
        queryKey: ["develop", userId, "files", address],
        staleTime: MINUTE_MS,
    });
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
        queryKey: [...options.queryKey, userId],
        staleTime: MINUTE_MS,
    });
};
