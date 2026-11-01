import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

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

/**
 * A guide is reserved under the head the host reported when it was started, which can be newer than the head this page
 * loaded. A guide for another head than the page's is therefore a reason to read the pull request again, once per such
 * head: if the page's head moves it matches and the guide reads as current, and if it does not the guide is older.
 * The files and commits are read again with it: they are keyed by address alone, and the merge and review panels act on
 * the pull's head, so a head that moved under a diff loaded for the old one would let a reviewer act on a commit they never saw.
 * Remembered per user and pull request, so the same guide head on another pull request refreshes that one too.
 */
export const useRefreshPullForOtherGuideHead = (address: PullRequestAddress, guideHeadSha: string | undefined, pageHeadSha: string): void => {
    const queryClient = useQueryClient();
    const userId = useDevelopUser();
    const refreshed = useRef(new Set<string>());

    useEffect(() => {
        const seen = `${String(userId)}|${address.repository}#${String(address.number)}|${String(guideHeadSha)}`;

        if (guideHeadSha === undefined || guideHeadSha === pageHeadSha || refreshed.current.has(seen)) {
            return;
        }

        refreshed.current.add(seen);

        for (const kind of ["pull", "files", "commits"]) {
            void queryClient.invalidateQueries({ queryKey: [DEVELOP_QUERY_ROOT, userId, kind, address] });
        }
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
