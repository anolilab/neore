import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/**
 * The usage rollup's two one-shot walks (`usage/backfill.ts`), started — or
 * resumed — once when a usage view opens. The status is live, so it flips to
 * done without polling. `backfilling`: the first walk, which fills the totals
 * and skills, is still running. `projectsBackfilling`: either walk is, so the
 * project breakdowns are still being filled.
 */
export const useUsageBackfill = (): { backfilling: boolean; projectsBackfilling: boolean } => {
    const crpc = useCRPC();
    const { data: status } = useQuery(crpc.usage.backfill.getUsageBackfillStatuses.queryOptions({}));
    const { mutate: start } = useMutation(crpc.usage.backfill.startUsageBackfill.mutationOptions());
    const started = useRef(false);
    const backfilling = status !== undefined && status.replies !== "done";
    const projectsBackfilling = backfilling || (status !== undefined && status.projects !== "done");

    useEffect(() => {
        if (!projectsBackfilling || started.current) {
            return;
        }

        started.current = true;
        start({});
    }, [projectsBackfilling, start]);

    return { backfilling, projectsBackfilling };
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
