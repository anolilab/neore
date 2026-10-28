"use client";

/**
 * The workers a conversation started, under its messages: name, whether one is working, a link to
 * its thread, Stop while it works and, while it is idle, archive (the ordinary thread archive, so an archived worker refuses new messages).
 * Renders nothing for a conversation with no workers.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { useUnlockProof } from "@neore/client-runtime";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, Bot, SquareIcon } from "lucide-react";
import type { FC } from "react";

import { useUpdateThread } from "@/features/chat/core/hooks/use-threads";
import { useQuietMinutes, useStopWorker } from "@/features/sub-agents/hooks/use-stop-worker";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type WorkerState = "idle" | "queued" | "running";

interface WorkerRowStopProps {
    lastActivityAt: number | null;
    name: string;
    quietAfterMs: number;
    workerId: string;
}

/** A working worker's Stop, and "No progress" once its run has been silent past the threshold. */
const WorkerRowStop: FC<WorkerRowStopProps> = ({ lastActivityAt, name, quietAfterMs, workerId }) => {
    const { t } = useLingui();
    const { isPending, stop } = useStopWorker(workerId);
    const quietMinutes = useQuietMinutes(lastActivityAt, quietAfterMs);

    return (
        <>
            {quietMinutes !== null && (
                <Badge role="status" variant="outline">
                    {t`No progress for ${quietMinutes} min`}
                </Badge>
            )}
            <Button
                aria-label={t`Stop ${name}`}
                disabled={isPending}
                onClick={() => stop("current", (error) => showError(error instanceof Error ? error : t`Could not stop the worker.`))}
                size="icon-sm"
                type="button"
                variant="ghost"
            >
                <SquareIcon aria-hidden="true" />
            </Button>
        </>
    );
};

const WorkerList: FC<{ className?: string; threadId: string | undefined }> = ({ className, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const afterFirstPaint = useAfterFirstPaint();
    const updateThread = useUpdateThread();
    const unlockProof = useUnlockProof(threadId ?? "");
    const { data: workers } = useQuery(
        crpc.sub_agents.functions.listWorkers.queryOptions(threadId && afterFirstPaint ? { leadThreadId: threadId as Id<"threads">, unlockProof } : skipToken),
    );

    if (!workers || workers.length === 0) {
        return null;
    }

    const stateLabels: Record<WorkerState, string> = { idle: t`Idle`, queued: t`Queued`, running: t`Working` };

    return (
        <section aria-label={t`Workers`} className={className}>
            <ul className="flex flex-col gap-1">
                {workers.map((worker) => (
                    <li className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm" key={worker.workerId}>
                        <Bot aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                        <Link
                            className="min-w-0 flex-1 truncate underline-offset-4 hover:underline"
                            params={{ threadId: worker.workerId }}
                            to="/chat/$threadId"
                        >
                            {worker.name}
                        </Link>
                        <Badge variant="secondary">
                            <span aria-live="polite" role="status">
                                {worker.archived ? t`Archived` : stateLabels[worker.state]}
                            </span>
                        </Badge>
                        {worker.postFailed !== null && (
                            <Badge title={worker.postFailed} variant="destructive">
                                <span role="status">{t`Result not delivered`}</span>
                            </Badge>
                        )}
                        {!worker.archived && worker.state !== "idle" && (
                            <WorkerRowStop
                                lastActivityAt={worker.lastActivityAt}
                                name={worker.name}
                                quietAfterMs={worker.quietAfterMs}
                                workerId={worker.workerId}
                            />
                        )}
                        {!worker.archived && worker.state === "idle" && (
                            <Button
                                aria-label={t`Archive ${worker.name}`}
                                onClick={() => {
                                    updateThread({ status: "archived", threadId: worker.workerId as Id<"threads"> }).catch(() =>
                                        showError(t`Failed to archive the worker`),
                                    );
                                }}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                            >
                                <ArchiveIcon aria-hidden="true" />
                            </Button>
                        )}
                    </li>
                ))}
            </ul>
        </section>
    );
};

export default WorkerList;
