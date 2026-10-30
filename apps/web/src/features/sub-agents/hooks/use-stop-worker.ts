import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showInfo } from "@/lib/toast";

/** How often the quiet check re-reads the clock; a live query does not re-run as time passes. */
const QUIET_TICK_MS = 30_000;

/**
 * Stops a worker. Each click mints its own `clientId`, so a retry of one click is deduped by the
 * backend and a second click is a new stop. `stopRun` names the run the view showed: if it ended
 * meanwhile, nothing is stopped, and the person is told rather than left to guess.
 */
export const useStopWorker = (workerId: string) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const stop = useMutation(crpc.sub_agents.functions.stopWorker.mutationOptions());
    const send = (input: { runId?: string; scope: "all_queued" | "current" }, onError: (error: unknown) => void) =>
        stop.mutate(
            {
                clientId: crypto.randomUUID(),
                scope: input.scope,
                workerId: workerId as Id<"threads">,
                ...(input.runId && { runId: input.runId as Id<"subAgentRuns"> }),
            },
            {
                onError,
                onSuccess: ({ cancelled }) => {
                    if (cancelled === 0) {
                        showInfo(t`Nothing to stop: that run had already ended.`);
                    }
                },
            },
        );

    return {
        clearQueue: (onError: (error: unknown) => void) => send({ scope: "all_queued" }, onError),
        isPending: stop.isPending,
        stopRun: (runId: string, onError: (error: unknown) => void) => send({ runId, scope: "current" }, onError),
    };
};

/** The clock, re-read every {@link QUIET_TICK_MS} while `active`. */
export const useNow = (active: boolean): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = active ? setInterval(() => setNow(Date.now()), QUIET_TICK_MS) : undefined;

        return () => clearInterval(timer);
    }, [active]);

    return now;
};

/**
 * Whole minutes a running worker has been silent, once that passes `quietAfterMs`; `null` while it is
 * writing, idle, or not yet past the threshold. `lastActivityAt` is the run's newest write.
 */
export const quietMinutesAt = (now: number, lastActivityAt: number | null, quietAfterMs: number): number | null =>
    lastActivityAt === null || now - lastActivityAt < quietAfterMs ? null : Math.floor((now - lastActivityAt) / 60_000);

export const useQuietMinutes = (lastActivityAt: number | null, quietAfterMs: number): number | null =>
    quietMinutesAt(useNow(lastActivityAt !== null), lastActivityAt, quietAfterMs);
