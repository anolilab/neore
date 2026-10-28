import type { Id } from "@neore/backend/dataModel";
import { skipToken, useQuery } from "@tanstack/react-query";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

/**
 * The worker behind a thread, or `undefined` for any other thread. Waits for first paint and for the
 * relationship read the breadcrumb already makes (same query, so no second subscription), then asks
 * only for a thread that is a sub-agent's — so an ordinary chat pays for nothing extra. `isLoading`
 * holds while a sub-agent's thread has not yet answered whether it is a worker, so the caller can
 * withhold the chat composer a worker's thread refuses.
 */
const useWorker = (threadId: string | undefined) => {
    const crpc = useCRPC();
    const afterFirstPaint = useAfterFirstPaint();
    const { data: relationship } = useQuery(
        crpc.agent.threads.getThreadRelationship.queryOptions(threadId && afterFirstPaint ? { threadId: threadId as Id<"threads"> } : skipToken),
    );
    const { data: worker, isPending } = useQuery(
        crpc.sub_agents.functions.getWorker.queryOptions(
            threadId && relationship?.branchType === "subagent" ? { workerId: threadId as Id<"threads"> } : skipToken,
        ),
    );

    return { isLoading: relationship?.branchType === "subagent" && isPending, worker: worker ?? undefined };
};

export default useWorker;
