"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CalendarClock, Eye, GitBranch, Pencil, Play, Square, Trash2, Zap } from "lucide-react";

import type { BoardTask } from "../lib/task-board";
import { isInFlight } from "../lib/task-board";
import { TaskStatusBadge } from "./task-status";

/** Statuses a task can be (re)started from with the Run button. */
const RUNNABLE: ReadonlySet<BoardTask["status"]> = new Set(["done", "failed", "todo"]);

interface TaskCardProps {
    /** Titles of the tasks this one waits on, for the "waits on" line. */
    dependencyTitles: string[];
    goalTitle?: string;
    isBusy: boolean;
    onCancel: () => void;
    onDelete: () => void;
    onEdit: () => void;
    onOpen: () => void;
    onRun: () => void;
    parentTitle?: string;
    showStatus?: boolean;
    skillName?: string;
    task: BoardTask;
}

const TaskCard = ({
    dependencyTitles,
    goalTitle,
    isBusy,
    onCancel,
    onDelete,
    onEdit,
    onOpen,
    onRun,
    parentTitle,
    showStatus = false,
    skillName,
    task,
}: TaskCardProps) => {
    const { t } = useLingui();
    const inFlight = isInFlight(task.status);
    const canCancel = inFlight || task.status === "blocked";
    const canRun = RUNNABLE.has(task.status);
    const { title } = task;

    return (
        <article aria-label={title} className="bg-card border-border space-y-2 rounded-lg border p-3 text-sm shadow-xs">
            <div className="flex items-start justify-between gap-2">
                <h3 className="min-w-0 font-medium">
                    <button className="text-left break-words hover:underline focus-visible:underline" onClick={onOpen} type="button">
                        {title}
                    </button>
                </h3>
                {showStatus && <TaskStatusBadge status={task.status} />}
            </div>

            <ul className="text-muted-foreground space-y-1 text-xs">
                {parentTitle && (
                    <li className="flex items-center gap-1">
                        <GitBranch aria-hidden className="size-3" />
                        {t`Subtask of ${parentTitle}`}
                    </li>
                )}
                {goalTitle && <li>{t`Goal: ${goalTitle}`}</li>}
                {skillName && (
                    <li className="flex items-center gap-1">
                        <Zap aria-hidden className="size-3" />
                        {t`Skill: ${skillName}`}
                    </li>
                )}
                {dependencyTitles.length > 0 && <li>{t`Waits on: ${dependencyTitles.join(", ")}`}</li>}
                {task.cronExpression && (
                    <li className="flex items-center gap-1">
                        <CalendarClock aria-hidden className="size-3" />
                        {t`Repeats (${task.cronExpression} UTC)`}
                    </li>
                )}
                {task.attemptCount > 0 && <li>{t`Attempts: ${task.attemptCount}`}</li>}
            </ul>

            {task.status === "failed" && task.lastError && <p className="text-destructive line-clamp-2 text-xs">{task.lastError}</p>}
            {(task.status === "done" || task.status === "needs_review") && task.resultSummary && (
                <p className="text-muted-foreground line-clamp-3 text-xs">{task.resultSummary}</p>
            )}

            <div className="flex flex-wrap items-center gap-1 pt-1">
                {task.status === "needs_review" && (
                    <Button onClick={onOpen} size="sm" variant="default">
                        <Eye aria-hidden />
                        {t`Review`}
                    </Button>
                )}
                {canRun && (
                    <Button disabled={isBusy} onClick={onRun} size="sm" variant="outline">
                        <Play aria-hidden />
                        {task.status === "todo" ? t`Run` : t`Run again`}
                    </Button>
                )}
                {canCancel && (
                    <Button disabled={isBusy} onClick={onCancel} size="sm" variant="outline">
                        <Square aria-hidden />
                        {t`Cancel`}
                    </Button>
                )}
                <div className="ml-auto flex items-center gap-1">
                    <Button aria-label={t`Edit ${title}`} disabled={inFlight} onClick={onEdit} size="icon-sm" title={t`Edit`} variant="ghost">
                        <Pencil aria-hidden />
                    </Button>
                    <Button aria-label={t`Delete ${title}`} disabled={isBusy} onClick={onDelete} size="icon-sm" title={t`Delete`} variant="ghost">
                        <Trash2 aria-hidden />
                    </Button>
                </div>
            </div>
        </article>
    );
};

export default TaskCard;
