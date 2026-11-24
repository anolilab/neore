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
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArchiveIcon, Bot, SquareIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useUpdateThread } from "@/features/chat/core/hooks/use-threads";
import { chatActionConfirmations, CONFIRM_EVERYTHING } from "@/features/chat/thread-list/lib/chat-action-confirmations";
import { quietMinutesAt, useNow, useQuietMinutes, useStopWorker } from "@/features/sub-agents/hooks/use-stop-worker";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type WorkerState = "idle" | "queued" | "running";

interface WorkerRowStopProps {
    activeRunId: string | null;
    lastActivityAt: number | null;
    name: string;
    quietAfterMs: number;
    stopping: boolean;
    workerId: string;
}

/**
 * A working worker's Stop, and "No progress" once its run has been silent past the threshold. The
 * badge is not announced here: the list's one status region does that, once per transition.
 */
const WorkerRowStop: FC<WorkerRowStopProps> = ({ activeRunId, lastActivityAt, name, quietAfterMs, stopping, workerId }) => {
    const { t } = useLingui();
    const { isPending, stopRun } = useStopWorker(workerId);
    const quietMinutes = useQuietMinutes(lastActivityAt, quietAfterMs);

    return (
        <>
            {quietMinutes !== null && <Badge variant="outline">{t`No progress for ${quietMinutes} min`}</Badge>}
            <Button
                aria-label={t`Stop ${name}`}
                disabled={isPending || stopping || activeRunId === null}
                onClick={() =>
                    activeRunId !== null && stopRun(activeRunId, (error) => showError(error instanceof Error ? error : t`Could not stop the worker.`))
                }
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
    // An admin acting as the owner may not archive a chat, a worker's included: the server refuses it.
    const isImpersonating = useImpersonating();
    const unlockProof = useUnlockProof(threadId ?? "");
    const { data: workers } = useQuery(
        crpc.sub_agents.functions.listWorkers.queryOptions(threadId && afterFirstPaint ? { leadThreadId: threadId as Id<"threads">, unlockProof } : skipToken),
    );

    const { data: userSettings } = useUserSettings();
    const confirmations = userSettings === undefined ? CONFIRM_EVERYTHING : chatActionConfirmations(userSettings);
    // The archive waiting for confirmation, with the lead chat it was asked from. It counts only while that chat is still shown,
    // so a dialog opened in one chat cannot archive a worker after the person has moved to another.
    const [archiveTarget, setArchiveTarget] = useState<{ leadThreadId: string | undefined; workerId: string } | undefined>(undefined);
    const pendingArchive = archiveTarget !== undefined && archiveTarget.leadThreadId === threadId ? archiveTarget.workerId : undefined;

    // Leaving a lead chat, or its list going empty, ends the pending archive, so the dialog never reopens for a worker it was opened on.
    const hasWorkers = (workers?.length ?? 0) > 0;

    useEffect(() => () => setArchiveTarget(undefined), [threadId, hasWorkers]);
    const archiveWorker = (workerId: string) => {
        updateThread({ status: "archived", threadId: workerId as Id<"threads"> }).catch(() => showError(t`Failed to archive the worker`));
    };

    const now = useNow((workers ?? []).some((worker) => worker.lastActivityAt !== null));

    if (!workers || workers.length === 0) {
        return null;
    }

    const stateLabels: Record<WorkerState, string> = { idle: t`Idle`, queued: t`Queued`, running: t`Working` };
    const stateLabel = (worker: { archived: boolean; state: WorkerState; stopping: boolean }): string => {
        if (worker.archived) {
            return t`Archived`;
        }

        return worker.stopping ? t`Stopping…` : stateLabels[worker.state];
    };
    // Changes only when a worker goes quiet or recovers, so screen readers hear the transition, not every minute.
    const quietNames = workers.filter((worker) => quietMinutesAt(now, worker.lastActivityAt, worker.quietAfterMs) !== null).map((worker) => worker.name);

    return (
        <section aria-label={t`Workers`} className={className}>
            <p aria-live="polite" className="sr-only" role="status">
                {quietNames.length === 0 ? "" : t`No progress: ${quietNames.join(", ")}`}
            </p>
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
                                {stateLabel(worker)}
                            </span>
                        </Badge>
                        {worker.postFailed !== null && (
                            <Badge title={worker.postFailed} variant="destructive">
                                <span role="status">{t`Result not delivered`}</span>
                            </Badge>
                        )}
                        {!worker.archived && worker.state !== "idle" && (
                            <WorkerRowStop
                                activeRunId={worker.activeRunId}
                                lastActivityAt={worker.lastActivityAt}
                                name={worker.name}
                                quietAfterMs={worker.quietAfterMs}
                                stopping={worker.stopping}
                                workerId={worker.workerId}
                            />
                        )}
                        {!worker.archived && worker.state === "idle" && !worker.stopping && !isImpersonating && (
                            <Button
                                aria-label={t`Archive ${worker.name}`}
                                onClick={() => {
                                    if (confirmations.archive) {
                                        setArchiveTarget({ leadThreadId: threadId, workerId: worker.workerId });

                                        return;
                                    }

                                    archiveWorker(worker.workerId);
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
            <ConfirmDialog
                confirmLabel={t`Archive`}
                description={t`Archived chats stay searchable, and you can restore them from the archive.`}
                onConfirm={() => {
                    // Checked again now: the dialog can stay open while the worker starts working, and an active worker is never archived.
                    const worker = workers.find((candidate) => candidate.workerId === pendingArchive);

                    if (worker !== undefined && worker.state === "idle" && !worker.stopping && !worker.archived && !isImpersonating) {
                        archiveWorker(worker.workerId);
                    }

                    setArchiveTarget(undefined);
                }}
                onOpenChange={(open) => {
                    if (!open) {
                        setArchiveTarget(undefined);
                    }
                }}
                open={pendingArchive !== undefined}
                title={t`Archive this chat?`}
            />
        </section>
    );
};

export default WorkerList;
