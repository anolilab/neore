import type { QueryKey } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * The usage rollup's one-shot backfill (`usage/backfill.ts`), started — or
 * resumed — once when the usage page opens. The status is live, so it flips to
 * done without polling; `backfilling` is true until then.
 */
export const useUsageBackfill = (): { backfilling: boolean } => {
    const crpc = useCRPC();
    const { data: status } = useQuery(crpc.usage.backfill.getUsageBackfillStatus.queryOptions({}));
    const { mutate: start } = useMutation(crpc.usage.backfill.startUsageBackfill.mutationOptions());
    const started = useRef(false);

    useEffect(() => {
        if (status === undefined || status === "done" || started.current) {
            return;
        }

        started.current = true;
        start({});
    }, [start, status]);

    return { backfilling: status !== undefined && status !== "done" };
};

/** While the backfill runs, how often a one-shot usage query re-reads the rollup. */
export const BACKFILL_REFETCH_MS = 5000;

/** Re-reads once more when the backfill finishes, so the last step's rows show. */
export const useRefetchAfterBackfill = (backfilling: boolean, refetch: () => Promise<unknown>, ready = true): void => {
    const wasBackfilling = useRef(backfilling);

    useEffect(() => {
        // A query still waiting for its inputs (`ready` false) reads fresh once they arrive; a refetch now would fail it.
        if (wasBackfilling.current && !backfilling && ready) {
            void refetch();
        }

        wasBackfilling.current = backfilling;
    }, [backfilling, ready, refetch]);
};

/**
 * When the backfill finishes, invalidates the query: one the page is showing reads again now, and one it is not showing (disabled) is only
 * marked stale, so it reads fresh the next time it is enabled. A disabled query is never run by this.
 */
export const useStaleAfterBackfill = (backfilling: boolean, queryKey: QueryKey, ready = true): void => {
    const queryClient = useQueryClient();
    const wasBackfilling = useRef(backfilling);

    useEffect(() => {
        if (wasBackfilling.current && !backfilling && ready) {
            void queryClient.invalidateQueries({ queryKey });
        }

        wasBackfilling.current = backfilling;
    }, [backfilling, queryClient, queryKey, ready]);
};
