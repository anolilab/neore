import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import type { QueryClient } from "@tanstack/react-query";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";
import { DEVELOP_QUERY_ROOT, useDevelopUser } from "./use-develop";

/** The time, moved on every half minute: whether a computer counts as online is read off it. */
export const useNow = (): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000);

        return () => clearInterval(timer);
    }, []);

    return now;
};

/** The guide for the head the page shows: live, so it fills in as the job or the host turn finishes. */
export const useGuide = (address: PullRequestAddress, headSha: string, enabled: boolean) => {
    const crpc = useCRPC();

    return useQuery(crpc.source_control.guide_functions.getGuide.queryOptions(enabled ? { ...address, headSha } : skipToken));
};

/** What one guide head has cost so far: reads started, whether one succeeded, whether one is running. */
interface RefreshRecord {
    attempts: number;
    done: boolean;
    running: boolean;
}

/** A refresh that failed, or came back without a head, is tried again on a later visit, this many times in all. */
const MAX_REFRESH_ATTEMPTS = 3;

/** Guide heads already refreshed, per query client (the cache), so they survive the tab unmounting. */
const refreshedGuideHeads = new WeakMap<QueryClient, Map<string, RefreshRecord>>();

const isPullHeadKnown = (data: unknown): boolean => {
    const pull = data as { detail?: { headSha?: unknown }; status?: unknown } | undefined;

    return pull?.status === "ok" && typeof pull.detail?.headSha === "string";
};

/**
 * A guide is reserved under the head the host reported when it was started, which can be newer than the head this page
 * loaded. A guide for another head than the page's is therefore a reason to read the pull request again: if the page's
 * head moves it matches and the guide reads as current, and if it does not the guide is older.
 * The files and commits are read again with it: they are keyed by address alone, and the merge and review panels act on
 * the pull's head, so a head that moved under a diff loaded for the old one would let a reviewer act on a commit they never saw.
 * Remembered per user and pull request, so the same guide head on another pull request refreshes that one too. The record
 * belongs to the query client, not to the component, so leaving the tab and coming back to the same stale guide does not
 * read the pull request, files and commits a second time. A head counts as refreshed only once the reads came back and the
 * pull request's head is known; a failed read is tried again on a later visit, at most `MAX_REFRESH_ATTEMPTS` times, so a
 * guide that is simply older than the pull request does not read the host on every visit.
 */
export const useRefreshPullForOtherGuideHead = (address: PullRequestAddress, guideHeadSha: string | undefined, pageHeadSha: string): void => {
    const queryClient = useQueryClient();
    const userId = useDevelopUser();

    useEffect(() => {
        if (guideHeadSha === undefined || guideHeadSha === pageHeadSha) {
            return;
        }

        const seen = `${String(userId)}|${address.repository}#${String(address.number)}|${guideHeadSha}`;

        let refreshed = refreshedGuideHeads.get(queryClient);

        if (!refreshed) {
            refreshed = new Map<string, RefreshRecord>();
            refreshedGuideHeads.set(queryClient, refreshed);
        }

        let record = refreshed.get(seen);

        if (!record) {
            record = { attempts: 0, done: false, running: false };
            refreshed.set(seen, record);
        }

        if (record.done || record.running || record.attempts >= MAX_REFRESH_ATTEMPTS) {
            return;
        }

        const current = record;
        const pullKey = [DEVELOP_QUERY_ROOT, userId, "pull", address];
        const keys = [pullKey, ...["files", "commits"].map((kind) => [DEVELOP_QUERY_ROOT, userId, kind, address])];

        current.attempts += 1;
        current.running = true;

        void Promise.allSettled(keys.map(async (queryKey) => await queryClient.invalidateQueries({ queryKey })))
            .then(() => {
                const failed = keys.some((queryKey) => queryClient.getQueryState(queryKey)?.status === "error");

                current.done = !failed && isPullHeadKnown(queryClient.getQueryData(pullKey));

                return undefined;
            })
            .finally(() => {
                current.running = false;
            });
    }, [address, guideHeadSha, pageHeadSha, queryClient, userId]);
};

/** The computers the user paired and what each offers. Read only once the Guide tab is open. */
export const useGuideDevices = (enabled: boolean) => {
    const crpc = useCRPC();

    return useQuery({ ...crpc.devices.functions.listDevices.queryOptions({}), enabled });
};

export const useGuideActions = (address: PullRequestAddress) => {
    const crpc = useCRPC();
    const generate = useAction(api.source_control.guide_functions.generateGuide);
    const startHost = useAction(api.source_control.guide_host.startHostGuide);

    return {
        apply: useMutation(crpc.source_control.guide_functions.applyGuideProposal.mutationOptions()),
        dismiss: useMutation(crpc.source_control.guide_functions.dismissGuideProposal.mutationOptions()),
        generate: useMutation({ mutationFn: async (input: { instructions: string }) => await generate({ ...address, ...input }) }),
        startHost: useMutation({
            mutationFn: async (input: { agentKey: string; deviceId: string; folderId: string; instructions: string }) =>
                await startHost({ ...address, ...input, deviceId: input.deviceId as Id<"devices"> }),
        }),
    };
};
