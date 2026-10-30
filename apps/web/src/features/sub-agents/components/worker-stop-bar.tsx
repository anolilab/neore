"use client";

/**
 * What a worker's thread shows while it is working: Stop for the run going, a second control that
 * also clears the messages queued behind it (or, once a stop is unwinding, just clears them), and
 * "No progress for N min" once the run has been silent past the quiet threshold. Renders nothing
 * for an idle worker.
 */

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { SquareIcon } from "lucide-react";
import type { FC } from "react";

import { useQuietMinutes, useStopWorker } from "@/features/sub-agents/hooks/use-stop-worker";
import { showError } from "@/lib/toast";

interface WorkerStopBarProps {
    /** The run the Stop is for: the one going, else the next in line. */
    activeRunId: string | null;
    className?: string;
    lastActivityAt: number | null;
    queuedRuns: number;
    quietAfterMs: number;
    state: "idle" | "queued" | "running";
    /** A stopped run's loop has not exited yet: it still writes, and the queue waits for it. */
    stopping: boolean;
    workerId: string;
}

const WorkerStopBar: FC<WorkerStopBarProps> = ({ activeRunId, className, lastActivityAt, queuedRuns, quietAfterMs, state, stopping, workerId }) => {
    const { t } = useLingui();
    const { clearQueue, isPending, stopRun } = useStopWorker(workerId);
    const quietMinutes = useQuietMinutes(lastActivityAt, quietAfterMs);

    if (state === "idle" && !stopping) {
        return null;
    }

    const onError = (error: unknown) => showError(error instanceof Error ? error : t`Could not stop the worker.`);
    // A queued message behind a stopped run has no Stop of its own to reach it: clearing is how it is cancelled.
    const canClear = queuedRuns > 0 && (state === "running" || stopping || queuedRuns > 1);

    return (
        <div className={className}>
            {/* Mounted for the life of the bar and announcing only the change into "no progress", not each passing minute. */}
            <p aria-live="polite" className="sr-only" role="status">
                {quietMinutes === null ? "" : t`No progress`}
            </p>
            {quietMinutes !== null && <p className="text-muted-foreground mb-2 text-xs">{t`No progress for ${quietMinutes} min`}</p>}
            {stopping && <p className="text-muted-foreground mb-2 text-xs">{t`Stopping…`}</p>}
            <div className="flex items-center gap-2">
                {!stopping && activeRunId !== null && (
                    <Button disabled={isPending} onClick={() => stopRun(activeRunId, onError)} size="sm" type="button" variant="outline">
                        <SquareIcon aria-hidden="true" />
                        {t`Stop`}
                    </Button>
                )}
                {canClear && (
                    <Button disabled={isPending} onClick={() => clearQueue(onError)} size="sm" type="button" variant="ghost">
                        {state === "running" ? t`Stop and clear the queue` : t`Clear the queue`}
                    </Button>
                )}
            </div>
        </div>
    );
};

export default WorkerStopBar;
