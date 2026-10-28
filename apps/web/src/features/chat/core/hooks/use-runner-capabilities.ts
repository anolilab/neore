import type { CapabilityReport } from "@neore/ai/capabilities";
import { CLOUD_INTERACTIVE_CAPABILITIES, LOCAL_BROWSER_CAPABILITIES } from "@neore/ai/capabilities";
import { skipToken, useQuery } from "@tanstack/react-query";

import { useChatIsStreaming, useChatThread } from "@/features/chat/core/context/chat-context";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * What the thread's runner can do, for the controls that depend on it (see
 * `@neore/ai/capabilities`). The runner KIND decides, never a model or agent name:
 * a `local-browser` endpoint and the cloud loop are declared in code, so only a
 * host-run thread asks the backend for its stored report. `null` until that report
 * arrives, which every rule reads as "unsupported".
 */
const useRunnerCapabilities = (): CapabilityReport | null => {
    const crpc = useCRPC();
    const { isLocalModel } = useChatIsStreaming();
    const { thread, threadId } = useChatThread();
    const isHostRun = thread?.runner === "host";
    const { data } = useQuery(crpc.acp.functions.getThreadCapabilities.queryOptions(isHostRun && threadId ? { threadId } : skipToken));

    if (isHostRun) {
        return data ?? null;
    }

    return isLocalModel ? LOCAL_BROWSER_CAPABILITIES : CLOUD_INTERACTIVE_CAPABILITIES;
};

export default useRunnerCapabilities;
