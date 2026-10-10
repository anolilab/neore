import { useMutation, useQuery } from "@tanstack/react-query";
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
export const useRefetchAfterBackfill = (backfilling: boolean, refetch: () => Promise<unknown>): void => {
    const wasBackfilling = useRef(backfilling);

    useEffect(() => {
        if (wasBackfilling.current && !backfilling) {
            void refetch();
        }

        wasBackfilling.current = backfilling;
    }, [backfilling, refetch]);
};
