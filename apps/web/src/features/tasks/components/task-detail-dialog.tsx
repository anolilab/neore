"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, MessageSquare, RotateCcw, X } from "lucide-react";
import { lazy, Suspense, useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import type { BoardTask } from "../lib/task-board";
import { NOTE_MAX, reviewReason } from "../lib/task-board";
import { TaskStatusBadge } from "./task-status";

interface TaskDetailDialogProps {
    onClose: () => void;
    task: BoardTask | null;
}

const RUNS_SHOWN = 20;

const LazyCodingAgentRunView = lazy(() => import("@/features/coding-agents/components/coding-agent-run-view"));

/** The latest coding-agent run of a task assigned to one: its live log, diff and PR controls. */
const CodingAgentRunPanel = ({ task }: { task: BoardTask }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data: run } = useQuery(crpc.coding_agents.functions.getLatestRunForTask.queryOptions({ taskId: task._id }));

    return (
        <section aria-labelledby={headingId} className="space-y-2">
            <h3 className="text-sm font-medium" id={headingId}>
                {t`Latest coding agent run`}
            </h3>
            {run ? (
                <Suspense fallback={null}>
                    <LazyCodingAgentRunView className="my-0 max-w-none" run={run} />
                </Suspense>
            ) : (
                <p className="text-muted-foreground text-xs">{t`No coding agent run yet.`}</p>
            )}
        </section>
    );
};

const RUN_BADGE_VARIANT = {
    cancelled: "outline",
    error: "destructive",
    failed: "destructive",
    passed: "secondary",
    running: "outline",
} as const;

const ReviewPanel = ({ task }: { task: BoardTask }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const noteId = useId();
    const [note, setNote] = useState("");
    const review = useMutation(crpc.tasks.functions.reviewTask.mutationOptions());
    // The same query `RunHistory` renders, so this shares its cache entry.
    const { data: runs } = useQuery(crpc.tasks.functions.getTaskRuns.queryOptions({ limit: RUNS_SHOWN, taskId: task._id }));

    const decide = (decision: "approve" | "reject" | "retry") => {
        review.mutate(
            { decision, note: decision === "retry" && note.trim() ? note.trim() : undefined, taskId: task._id },
            {
                onError: (error) => toast.error(error.message || t`Failed to submit the review`),
                onSuccess: () => {
                    setNote("");
                    const messages = { approve: t`Task approved`, reject: t`Task rejected`, retry: t`Task queued for another run` };

                    toast.success(messages[decision]);
                },
            },
        );
    };

    return (
        <section aria-labelledby={`${noteId}-heading`} className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
            <h3 className="text-sm font-medium" id={`${noteId}-heading`}>
                {t`Your review`}
            </h3>
            <p className="text-muted-foreground text-xs">
                {reviewReason(runs) === "unverified"
                    ? t`Verification could not run, so nobody has checked this result. Review the answer yourself: approve it as is, reject it, or send it back with a note.`
                    : t`The verifier did not pass this result after the allowed repair rounds. Approve it as is, reject it, or send it back with a note.`}
            </p>
            <div className="space-y-2">
                <Label htmlFor={noteId}>{t`Note for the next run (optional)`}</Label>
                <Textarea id={noteId} maxLength={NOTE_MAX} onChange={(event) => setNote(event.target.value)} value={note} />
            </div>
            <div className="flex flex-wrap gap-2">
                <Button disabled={review.isPending} onClick={() => decide("approve")} size="sm">
                    <Check aria-hidden />
                    {t`Approve`}
                </Button>
                <Button disabled={review.isPending} onClick={() => decide("retry")} size="sm" variant="outline">
                    <RotateCcw aria-hidden />
                    {note.trim() ? t`Retry with note` : t`Retry`}
                </Button>
                <Button disabled={review.isPending} onClick={() => decide("reject")} size="sm" variant="destructive">
                    <X aria-hidden />
                    {t`Reject`}
                </Button>
            </div>
        </section>
    );
};

const RunHistory = ({ task }: { task: BoardTask }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const { data: runs, isLoading } = useQuery(crpc.tasks.functions.getTaskRuns.queryOptions({ limit: RUNS_SHOWN, taskId: task._id }));

    const originLabels = {
        dependency: t`started when its dependencies finished`,
        manual: t`started manually`,
        repair: t`repair round`,
        retry: t`retried after review`,
        schedule: t`started on schedule`,
    } as const;

    const runStatusLabels = {
        cancelled: t`Cancelled`,
        error: t`Error`,
        failed: t`Did not pass`,
        passed: t`Passed`,
        running: t`Running`,
    } as const;

    return (
        <section aria-labelledby={headingId} className="space-y-2">
            <h3 className="text-sm font-medium" id={headingId}>
                {t`Run history`}
            </h3>
            {isLoading && (
                <p className="text-muted-foreground text-xs" role="status">
                    {t`Loading runs…`}
                </p>
            )}
            {!isLoading && (!runs || runs.length === 0) && <p className="text-muted-foreground text-xs">{t`This task has not run yet.`}</p>}
            {runs && runs.length > 0 && (
                <ol className="space-y-2">
                    {runs.map((run) => {
                        const started = i18n.date(new Date(run.startedAt), { dateStyle: "medium", timeStyle: "short" });
                        const label = run.round === 0 ? t`Attempt` : t`Repair ${run.round}`;

                        return (
                            <li className="border-border space-y-2 rounded-md border p-3 text-xs" key={run._id}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="font-medium">{label}</span>
                                    <Badge variant={RUN_BADGE_VARIANT[run.status]}>{runStatusLabels[run.status]}</Badge>
                                    <span className="text-muted-foreground">
                                        <time dateTime={new Date(run.startedAt).toISOString()}>{started}</time> · {originLabels[run.origin]}
                                    </span>
                                    {run.threadId && (
                                        <Link
                                            className="text-primary ml-auto inline-flex items-center gap-1 hover:underline"
                                            params={{ threadId: run.threadId }}
                                            to="/chat/$threadId"
                                        >
                                            {t`Open run thread`}
                                            <MessageSquare aria-hidden className="size-3" />
                                        </Link>
                                    )}
                                </div>
                                {run.error && <p className="text-destructive">{run.error}</p>}
                                {run.verdict && (
                                    <div className="space-y-1">
                                        <p className="font-medium">{run.verdict.pass ? t`Verifier: passed` : t`Verifier: not passed`}</p>
                                        <ul className="text-muted-foreground list-disc space-y-0.5 pl-4">
                                            {run.verdict.reasons.map((reason) => (
                                                <li key={reason}>{reason}</li>
                                            ))}
                                        </ul>
                                        {run.verdict.repairInstructions && (
                                            <p>
                                                <span className="font-medium">{t`Repair instructions:`}</span> {run.verdict.repairInstructions}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ol>
            )}
        </section>
    );
};

const TaskDetailDialog = ({ onClose, task }: TaskDetailDialogProps) => {
    const { t } = useLingui();

    return (
        <Dialog onOpenChange={(nextOpen) => !nextOpen && onClose()} open={task !== null}>
            {task && (
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{task.title}</DialogTitle>
                        <DialogDescription>{t`Task details, your review and the run history.`}</DialogDescription>
                        <div>
                            <TaskStatusBadge status={task.status} />
                        </div>
                    </DialogHeader>
                    <DialogPanel className="max-h-[70vh] min-h-0 flex-1 overflow-y-auto">
                        <div className="space-y-5 text-sm">
                            {task.status === "needs_review" && <ReviewPanel task={task} />}

                            <dl className="space-y-3">
                                {task.codingAgent && (
                                    <div>
                                        <dt className="text-xs font-medium">{t`Assigned to`}</dt>
                                        <dd className="text-muted-foreground">
                                            {task.codingAgent.agent === "codex" ? "OpenAI Codex" : "Claude Code"}
                                            {" · "}
                                            <span className="font-mono">{task.codingAgent.repoUrl}</span>
                                            {task.codingAgent.branch ? ` (${task.codingAgent.branch})` : ""}
                                        </dd>
                                    </div>
                                )}
                                <div>
                                    <dt className="text-xs font-medium">{t`Instructions`}</dt>
                                    <dd className="text-muted-foreground whitespace-pre-wrap">{task.instructions}</dd>
                                </div>
                                {task.successCriteria && (
                                    <div>
                                        <dt className="text-xs font-medium">{t`Success criteria`}</dt>
                                        <dd className="text-muted-foreground whitespace-pre-wrap">{task.successCriteria}</dd>
                                    </div>
                                )}
                                {task.reviewNote && (
                                    <div>
                                        <dt className="text-xs font-medium">{t`Reviewer note`}</dt>
                                        <dd className="text-muted-foreground whitespace-pre-wrap">{task.reviewNote}</dd>
                                    </div>
                                )}
                                {task.resultSummary && (
                                    <div>
                                        <dt className="text-xs font-medium">{t`Latest result`}</dt>
                                        <dd className="text-muted-foreground whitespace-pre-wrap">{task.resultSummary}</dd>
                                    </div>
                                )}
                                {task.lastError && (
                                    <div>
                                        <dt className="text-xs font-medium">{t`Last error`}</dt>
                                        <dd className="text-destructive">{task.lastError}</dd>
                                    </div>
                                )}
                            </dl>

                            {task.codingAgent && <CodingAgentRunPanel task={task} />}

                            <RunHistory task={task} />
                        </div>
                    </DialogPanel>
                </DialogContent>
            )}
        </Dialog>
    );
};

export default TaskDetailDialog;
