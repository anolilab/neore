import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

/** How often the quiet check re-reads the clock; a live query does not re-run as time passes. */
const QUIET_TICK_MS = 30_000;

/**
 * Stops a worker. Each click mints its own `clientId`, so a retry of one click is deduped by the
 * backend and a second click is a new stop (which ends nothing while only a stopped loop is live).
 */
export const useStopWorker = (workerId: string) => {
    const crpc = useCRPC();
    const stop = useMutation(crpc.sub_agents.functions.stopWorker.mutationOptions());

    return {
        isPending: stop.isPending,
        stop: (scope: "all_queued" | "current", onError: (error: unknown) => void) =>
            stop.mutate({ clientId: crypto.randomUUID(), scope, workerId: workerId as Id<"threads"> }, { onError }),
    };
};

/**
 * Whole minutes a running worker has been silent, once that passes `quietAfterMs`; `null` while it is
 * writing, idle, or not yet past the threshold. `lastActivityAt` is the run's newest write.
 */
export const useQuietMinutes = (lastActivityAt: number | null, quietAfterMs: number): number | null => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = lastActivityAt === null ? undefined : setInterval(() => setNow(Date.now()), QUIET_TICK_MS);

        return () => clearInterval(timer);
    }, [lastActivityAt]);

    if (lastActivityAt === null || now - lastActivityAt < quietAfterMs) {
        return null;
    }

    return Math.floor((now - lastActivityAt) / 60_000);
};
