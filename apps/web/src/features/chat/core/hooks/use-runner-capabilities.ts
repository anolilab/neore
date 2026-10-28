import type { CapabilityReport } from "@neore/ai/capabilities";
import { CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * A host's native steer is not wired end to end: `steerRun` refuses a host turn
 * (`chat/steering.ts`). It reads as no follow-up until that lands.
 */
const withoutNativeSteer = (report: CapabilityReport): CapabilityReport => {
    const followUp = report.groups.turns?.followUp;

    if (followUp?.kind !== "steer" || followUp.degradation !== undefined) {
        return report;
    }

    return { ...report, groups: { ...report.groups, turns: { ...report.groups.turns, followUp: { kind: "none" } } } };
};

/**
 * What the thread's runner can do, for the controls that depend on it (see
 * `@neore/ai/capabilities`). The runner KIND decides, never a model or agent name:
 * a `local-browser` endpoint and the cloud loop are declared in code, so only a
 * host-run thread asks the backend for its stored report. `null` until the thread
 * (or, for a host, its report) has loaded, which every rule reads as "unsupported".
 */
const useRunnerCapabilities = (): CapabilityReport | null => {
    const crpc = useCRPC();
    const { isLocalModel } = useChatIsStreaming();
    const { thread, threadId } = useChatThread();
    const isHostRun = thread?.runner === "host";
    const { data } = useQuery(crpc.acp.functions.getThreadCapabilities.queryOptions(isHostRun && threadId ? { threadId } : skipToken));

    if (threadId && !thread) {
        return null;
    }

    if (isHostRun) {
        return data ? withoutNativeSteer(data) : null;
    }

    return isLocalModel ? LOCAL_BROWSER_CAPABILITIES : CLOUD_INTERACTIVE_CAPABILITIES;
};

export default useRunnerCapabilities;
