"use client";

/**
 * What a worker's thread shows while it is working: the Stop control, a second one that also clears
 * the messages queued behind the run, and "No progress for N min" once the run has been silent past
 * the quiet threshold. Renders nothing for an idle worker.
 */

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { SquareIcon } from "lucide-react";
import type { FC } from "react";

import { useQuietMinutes, useStopWorker } from "@/features/sub-agents/hooks/use-stop-worker";
import { showError } from "@/lib/toast";

interface WorkerStopBarProps {
    className?: string;
    lastActivityAt: number | null;
    queuedRuns: number;
    quietAfterMs: number;
    state: "idle" | "queued" | "running";
    workerId: string;
}

const WorkerStopBar: FC<WorkerStopBarProps> = ({ className, lastActivityAt, queuedRuns, quietAfterMs, state, workerId }) => {
    const { t } = useLingui();
    const { isPending, stop } = useStopWorker(workerId);
    const quietMinutes = useQuietMinutes(lastActivityAt, quietAfterMs);

    if (state === "idle") {
        return null;
    }

    const onError = (error: unknown) => showError(error instanceof Error ? error : t`Could not stop the worker.`);

    return (
        <div className={className}>
            {quietMinutes !== null && (
                <p className="text-muted-foreground mb-2 text-xs" role="status">
                    {t`No progress for ${quietMinutes} min`}
                </p>
            )}
            <div className="flex items-center gap-2">
                <Button disabled={isPending} onClick={() => stop("current", onError)} size="sm" type="button" variant="outline">
                    <SquareIcon aria-hidden="true" />
                    {t`Stop`}
                </Button>
                {queuedRuns > (state === "queued" ? 1 : 0) && (
                    <Button disabled={isPending} onClick={() => stop("all_queued", onError)} size="sm" type="button" variant="ghost">
                        {t`Stop and clear the queue`}
                    </Button>
                )}
            </div>
        </div>
    );
};

export default WorkerStopBar;
