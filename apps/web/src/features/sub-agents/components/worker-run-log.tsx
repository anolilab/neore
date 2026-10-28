"use client";

/**
 * The latest messages a worker ran, each with where it stands: queued, working, done, failed or
 * stopped, and whether its result reached the lead. A run's delivery is its own, so one result that
 * could not be posted never hides another's.
 */

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import type { FC } from "react";

interface WorkerRunLogRun {
    delivery: "failed" | "none" | "pending" | "posted";
    runId: string;
    state: "cancelled" | "failed" | "queued" | "running" | "succeeded";
    task: string;
}

const WorkerRunLog: FC<{ className?: string; runs: WorkerRunLogRun[] }> = ({ className, runs }) => {
    const { t } = useLingui();

    if (runs.length === 0) {
        return null;
    }

    const stateLabels = { cancelled: t`Stopped`, failed: t`Failed`, queued: t`Queued`, running: t`Working`, succeeded: t`Done` };
    const deliveryLabels = { failed: t`Not delivered to the lead`, none: undefined, pending: t`Delivering`, posted: t`Delivered to the lead` };

    return (
        <section aria-label={t`Recent messages`} className={className}>
            <ul className="flex flex-col gap-1">
                {runs.map((run) => (
                    <li className="flex items-center gap-2 text-xs" key={run.runId}>
                        <span className="text-muted-foreground min-w-0 flex-1 truncate">{run.task}</span>
                        <Badge variant="secondary">{stateLabels[run.state]}</Badge>
                        {deliveryLabels[run.delivery] && (
                            <Badge variant={run.delivery === "failed" ? "destructive" : "outline"}>{deliveryLabels[run.delivery]}</Badge>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
};

export default WorkerRunLog;
