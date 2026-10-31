import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useAction, useCRPC } from "@/lib/lunora/crpc";

import type { PullRequestAddress } from "./use-develop";

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
