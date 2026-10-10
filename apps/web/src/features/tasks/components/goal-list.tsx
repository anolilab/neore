"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Progress, ProgressIndicator, ProgressLabel, ProgressTrack, ProgressValue } from "@neore/ui/components/progress";
import cn from "@neore/ui/utils/cn";
import { Pencil, Trash2 } from "lucide-react";

import type { BoardGoal } from "../lib/task-board";

interface GoalListProps {
    goals: ReadonlyArray<BoardGoal>;
    onDelete: (goal: BoardGoal) => void;
    onEdit: (goal: BoardGoal) => void;
    onSelect: (goalId: Id<"goals"> | null) => void;
    selectedGoalId: Id<"goals"> | null;
}

/** Goals with progress derived from their tasks. Selecting one filters the board to it. */
const GoalList = ({ goals, onDelete, onEdit, onSelect, selectedGoalId }: GoalListProps) => {
    const { t } = useLingui();

    const statusLabels: Record<BoardGoal["status"], string> = {
        active: t`Active`,
        archived: t`Archived`,
        completed: t`Completed`,
    };

    return (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {goals.map((goal) => {
                const { progress, title } = goal;
                const isSelected = selectedGoalId === goal._id;

                return (
                    <li
                        className={cn("bg-card space-y-3 rounded-lg border p-4", isSelected ? "border-primary ring-primary/30 ring-2" : "border-border")}
                        key={goal._id}
                    >
                        <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 space-y-1">
                                <h3 className="text-sm font-medium break-words">{title}</h3>
                                <p className="text-muted-foreground text-xs">
                                    {statusLabels[goal.status]}
                                    {progress.needsReview > 0 && ` · ${t`${progress.needsReview} to review`}`}
                                    {progress.failed > 0 && ` · ${t`${progress.failed} failed`}`}
                                </p>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Button aria-label={t`Edit goal ${title}`} onClick={() => onEdit(goal)} size="icon-sm" title={t`Edit`} variant="ghost">
                                    <Pencil aria-hidden />
                                </Button>
                                <Button aria-label={t`Delete goal ${title}`} onClick={() => onDelete(goal)} size="icon-sm" title={t`Delete`} variant="ghost">
                                    <Trash2 aria-hidden />
                                </Button>
                            </div>
                        </div>

                        {goal.description && <p className="text-muted-foreground line-clamp-2 text-xs">{goal.description}</p>}

                        <Progress max={100} value={progress.percent}>
                            <div className="flex items-center justify-between text-xs">
                                <ProgressLabel className="text-xs font-normal">{t`${progress.done} of ${progress.total} tasks done`}</ProgressLabel>
                                <ProgressValue className="text-xs" />
                            </div>
                            <ProgressTrack>
                                <ProgressIndicator />
                            </ProgressTrack>
                        </Progress>

                        <Button aria-pressed={isSelected} className="w-full" onClick={() => onSelect(isSelected ? null : goal._id)} size="sm" variant="outline">
                            {isSelected ? t`Show all tasks` : t`Show this goal's tasks`}
                        </Button>
                    </li>
                );
            })}
        </ul>
    );
};

export default GoalList;
