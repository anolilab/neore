import { api } from "@neore/backend/api";
import { LIVE_META_KEY } from "@neore/client-runtime";
import { skipToken, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";
import { useDevelopUser } from "./use-develop";

const MINUTE_MS = 60_000;

/** Host reads cost API budget: cache a little, never go live. */
const READ = { meta: { [LIVE_META_KEY]: false }, retry: false };

/** The review being written on a pull request. Live: another device's edits arrive as they are made. */
export const useReviewDraft = (address: PullRequestAddress | undefined) => {
    const crpc = useCRPC();

    return useQuery(crpc.source_control.review_drafts.getReviewDraft.queryOptions(address ?? skipToken));
};

export const useDraftMutations = () => {
    const crpc = useCRPC();

    return {
        deleteComment: useMutation(crpc.source_control.review_drafts.deleteDraftComment.mutationOptions()),
        discard: useMutation(crpc.source_control.review_drafts.discardReviewDraft.mutationOptions()),
        saveComment: useMutation(crpc.source_control.review_drafts.saveDraftComment.mutationOptions()),
        setReview: useMutation(crpc.source_control.review_drafts.setDraftReview.mutationOptions()),
    };
};

export const useReviewThreads = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getThreads = useAction(api.source_control.review_functions.getReviewThreads);
    const userId = useDevelopUser();

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }) => await getThreads({ ...(address as PullRequestAddress), ...(pageParam !== null && { after: pageParam }) }),
        initialPageParam: null as string | null,
        getNextPageParam: (last: Awaited<ReturnType<typeof getThreads>>) => (last.status === "ok" && last.hasMore ? last.endCursor : undefined),
        queryKey: ["develop", userId, "threads", address],
        staleTime: MINUTE_MS,
    });
};

/** Which files the user marked viewed on the host, read page by page until the host has no more. */
export const useViewedFiles = (address: PullRequestAddress | undefined, enabled: boolean) => {
    const getViewed = useAction(api.source_control.review_functions.getViewedFiles);
    const userId = useDevelopUser();

    return useInfiniteQuery({
        ...READ,
        enabled: enabled && address !== undefined && userId !== undefined,
        queryFn: async ({ pageParam }) => await getViewed({ ...(address as PullRequestAddress), ...(pageParam !== null && { after: pageParam }) }),
        initialPageParam: null as string | null,
        getNextPageParam: (last: Awaited<ReturnType<typeof getViewed>>) => (last.status === "ok" && last.hasMore ? last.endCursor : undefined),
        queryKey: ["develop", userId, "viewed", address],
        staleTime: MINUTE_MS,
    });
};

export const useReviewActions = (address: PullRequestAddress) => {
    const queryClient = useQueryClient();
    const userId = useDevelopUser();
    const reply = useAction(api.source_control.review_functions.replyToReviewThread);
    const resolve = useAction(api.source_control.review_functions.setReviewThreadResolved);
    const setViewed = useAction(api.source_control.review_functions.setFileViewed);
    const submit = useAction(api.source_control.review_functions.submitReview);
    const refreshThreads = async () => await queryClient.invalidateQueries({ queryKey: ["develop", userId, "threads", address] });
    const refreshViewed = async () => await queryClient.invalidateQueries({ queryKey: ["develop", userId, "viewed", address] });

    return {
        reply: useMutation({
            mutationFn: async (input: { body: string; commentId: string }) => await reply({ ...address, ...input }),
            onSuccess: async (outcome) => {
                if (outcome.status === "ok") {
                    await refreshThreads();
                }
            },
        }),
        resolve: useMutation({
            mutationFn: async (input: { resolved: boolean; threadId: string }) => await resolve(input),
            onSuccess: async (outcome) => {
                if (outcome.status === "ok") {
                    await refreshThreads();
                }
            },
        }),
        setViewed: useMutation({
            mutationFn: async (input: { path: string; viewed: boolean }) => await setViewed({ ...address, ...input }),
            onSettled: refreshViewed,
        }),
        submit: useMutation({
            mutationFn: async () => await submit(address),
            onSuccess: async (outcome) => {
                if (outcome.status === "ok") {
                    await refreshThreads();
                }
            },
        }),
    };
};
