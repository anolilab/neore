"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import ConfirmDialog from "@neore/ui/components/confirm-dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@neore/ui/components/empty";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, List, ListChecks, Plus, Target } from "lucide-react";
import { useCallback, useId, useMemo, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import useTaskNotifications from "../hooks/use-task-notifications";
import type { BoardGoal, BoardTask } from "../lib/task-board";
import { groupByStatus, isInFlight, STATUS_ORDER } from "../lib/task-board";
import type { GoalFormValues } from "./goal-form-dialog";
import GoalFormDialog from "./goal-form-dialog";
import GoalList from "./goal-list";
import TaskCard from "./task-card";
import TaskDetailDialog from "./task-detail-dialog";
import TaskFormDialog from "./task-form-dialog";
import { TaskStatusIcon, useTaskStatusLabels } from "./task-status";

type PendingDelete = { goal: BoardGoal; kind: "goal" } | { kind: "task"; task: BoardTask };

/**
 * The /tasks page: goals with derived progress, and the tasks as a board (one
 * column per status) or a list. Tasks awaiting review sort first everywhere,
 * since they are the only state that waits on the user.
 */
/** How often the board re-reads while a task is queued or running. */
const BOARD_POLL_MS = 3000;

const TasksPage = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const statusLabels = useTaskStatusLabels();

    const queryClient = useQueryClient();
    const boardQuery = crpc.tasks.functions.getTaskBoard.queryOptions({});

    // The board is a live query: task writes, including a run's server-side
    // status changes, push into it. The invalidations after each mutation and
    // the poll while a run is in flight are the fallback for when the
    // subscription is unavailable; while it is open they are answered from it
    // without an RPC.
    const { data: board, isLoading } = useQuery({
        ...boardQuery,
        refetchInterval: (query) => (query.state.data?.tasks.some((task) => isInFlight(task.status)) ? BOARD_POLL_MS : false),
    });
    const refreshBoard = {
        onSettled: async () => {
            await queryClient.invalidateQueries({ queryKey: boardQuery.queryKey });
        },
    };
    const { data: skills = [] } = useQuery(crpc.tasks.functions.listTaskSkillOptions.queryOptions({}));

    const [view, setView] = useState<"board" | "list">("board");
    const [selectedGoalId, setSelectedGoalId] = useState<Id<"goals"> | null>(null);
    const [taskDialog, setTaskDialog] = useState<{ open: boolean; task: BoardTask | null }>({ open: false, task: null });
    const [goalDialog, setGoalDialog] = useState<{ goal: BoardGoal | null; open: boolean }>({ goal: null, open: false });
    const [openTaskId, setOpenTaskId] = useState<Id<"tasks"> | null>(null);
    const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
    const [busyTaskId, setBusyTaskId] = useState<Id<"tasks"> | null>(null);

    const createTask = useMutation(crpc.tasks.functions.createTask.mutationOptions(refreshBoard));
    const updateTask = useMutation(crpc.tasks.functions.updateTask.mutationOptions(refreshBoard));
    const deleteTask = useMutation(crpc.tasks.functions.deleteTask.mutationOptions(refreshBoard));
    const runTask = useMutation(crpc.tasks.functions.runTask.mutationOptions(refreshBoard));
    const cancelTask = useMutation(crpc.tasks.functions.cancelTask.mutationOptions(refreshBoard));
    const createGoal = useMutation(crpc.tasks.functions.createGoal.mutationOptions(refreshBoard));
    const updateGoal = useMutation(crpc.tasks.functions.updateGoal.mutationOptions(refreshBoard));
    const deleteGoal = useMutation(crpc.tasks.functions.deleteGoal.mutationOptions(refreshBoard));

    const tasks = board?.tasks;
    const goals = useMemo(() => board?.goals ?? [], [board?.goals]);
    const allTasks = useMemo(() => tasks ?? [], [tasks]);

    useTaskNotifications(tasks, setOpenTaskId);

    const titleById = useMemo(() => new Map(allTasks.map((task) => [task._id as string, task.title])), [allTasks]);
    const goalTitleById = useMemo(() => new Map(goals.map((goal) => [goal._id as string, goal.title])), [goals]);
    const skillNameById = useMemo(() => new Map(skills.map((skill) => [skill._id as string, `/${skill.slug}`])), [skills]);

    const visibleTasks = useMemo(() => (selectedGoalId ? allTasks.filter((task) => task.goalId === selectedGoalId) : allTasks), [allTasks, selectedGoalId]);
    const grouped = useMemo(() => groupByStatus(visibleTasks), [visibleTasks]);
    const openTask = openTaskId ? (allTasks.find((task) => task._id === openTaskId) ?? null) : null;
    const reviewCount = grouped.get("needs_review")?.length ?? 0;
    let deleteTitle = "";

    if (pendingDelete) {
        deleteTitle = pendingDelete.kind === "goal" ? pendingDelete.goal.title : pendingDelete.task.title;
    }

    const act = useCallback(
        async (taskId: Id<"tasks">, run: () => Promise<unknown>, failure: string) => {
            setBusyTaskId(taskId);

            try {
                await run();
            } catch (error) {
                toast.error(error instanceof Error && error.message ? error.message : failure);
            } finally {
                setBusyTaskId(null);
            }
            // The setter is stable; listed because the compiler infers it as a dependency.
        },
        [setBusyTaskId],
    );

    const handleRun = (task: BoardTask) =>
        act(
            task._id,
            async () => {
                const { status } = await runTask.mutateAsync({ taskId: task._id });

                if (status === "blocked") {
                    toast.info(t`"${task.title}" will start once its dependencies are done`);
                }
            },
            t`Failed to start the task`,
        );

    const handleCancel = (task: BoardTask) => act(task._id, async () => await cancelTask.mutateAsync({ taskId: task._id }), t`Failed to cancel the task`);

    const confirmDelete = async () => {
        if (!pendingDelete) {
            return;
        }

        try {
            if (pendingDelete.kind === "task") {
                await deleteTask.mutateAsync({ taskId: pendingDelete.task._id });

                if (openTaskId === pendingDelete.task._id) {
                    setOpenTaskId(null);
                }
            } else {
                await deleteGoal.mutateAsync({ goalId: pendingDelete.goal._id });

                if (selectedGoalId === pendingDelete.goal._id) {
                    setSelectedGoalId(null);
                }
            }

            setPendingDelete(null);
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to delete`);
        }
    };

    const submitGoal = async (values: GoalFormValues) => {
        const payload = {
            description: values.description.trim() || undefined,
            successCriteria: values.successCriteria.trim() || undefined,
            title: values.title.trim(),
        };

        if (goalDialog.goal) {
            await updateGoal.mutateAsync({ ...payload, goalId: goalDialog.goal._id, status: values.status });
        } else {
            await createGoal.mutateAsync(payload);
        }
    };

    const renderCard = (task: BoardTask, showStatus: boolean) => (
        <TaskCard
            dependencyTitles={task.dependsOn.map((id) => titleById.get(id) ?? t`(deleted task)`)}
            goalTitle={selectedGoalId || !task.goalId ? undefined : goalTitleById.get(task.goalId)}
            isBusy={busyTaskId === task._id}
            onCancel={() => handleCancel(task)}
            onDelete={() => setPendingDelete({ kind: "task", task })}
            onEdit={() => setTaskDialog({ open: true, task })}
            onOpen={() => setOpenTaskId(task._id)}
            onRun={() => handleRun(task)}
            parentTitle={task.parentTaskId ? titleById.get(task.parentTaskId) : undefined}
            showStatus={showStatus}
            skillName={task.skillId ? (skillNameById.get(task.skillId) ?? t`(unavailable skill)`) : undefined}
            task={task}
        />
    );

    return (
        <div className="mx-auto max-w-7xl space-y-8">
            <header className="flex flex-wrap items-start justify-between gap-4">
                <div className="space-y-1">
                    <h1 className="text-xl font-semibold" id={headingId}>
                        {t`Tasks`}
                    </h1>
                    <p className="text-muted-foreground text-sm">
                        {t`Agents work your tasks on their own. A verifier checks each result against its success criteria, and anything it will not pass comes back to you.`}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button onClick={() => setGoalDialog({ goal: null, open: true })} variant="outline">
                        <Target aria-hidden />
                        {t`New goal`}
                    </Button>
                    <Button onClick={() => setTaskDialog({ open: true, task: null })}>
                        <Plus aria-hidden />
                        {t`New task`}
                    </Button>
                </div>
            </header>

            {isLoading && (
                <p className="text-muted-foreground text-sm" role="status">
                    {t`Loading tasks…`}
                </p>
            )}

            {/* Announces the one state that needs the user; the count is live. */}
            <p className="sr-only" role="status">
                {reviewCount > 0 ? t`${reviewCount} tasks need your review` : ""}
            </p>

            {goals.length > 0 && (
                <section aria-labelledby={`${headingId}-goals`} className="space-y-3">
                    <h2 className="text-sm font-medium" id={`${headingId}-goals`}>
                        {t`Goals`}
                    </h2>
                    <GoalList
                        goals={goals}
                        onDelete={(goal) => setPendingDelete({ goal, kind: "goal" })}
                        onEdit={(goal) => setGoalDialog({ goal, open: true })}
                        onSelect={setSelectedGoalId}
                        selectedGoalId={selectedGoalId}
                    />
                </section>
            )}

            {board && allTasks.length === 0 ? (
                <Empty>
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <ListChecks aria-hidden />
                        </EmptyMedia>
                        <EmptyTitle>{t`No tasks yet`}</EmptyTitle>
                        <EmptyDescription>{t`Create a task, give it success criteria, and run it. You can chain tasks with dependencies and repeat them on a schedule.`}</EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : (
                board && (
                    <section aria-labelledby={`${headingId}-tasks`} className="space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h2 className="text-sm font-medium" id={`${headingId}-tasks`}>
                                {selectedGoalId ? t`Tasks for ${goalTitleById.get(selectedGoalId) ?? ""}` : t`All tasks`}
                            </h2>
                        </div>
                        <Tabs onValueChange={(value) => setView(value === "list" ? "list" : "board")} value={view}>
                            <TabsList aria-label={t`Task views`}>
                                <TabsTrigger value="board">
                                    <Columns3 aria-hidden />
                                    {t`Board`}
                                </TabsTrigger>
                                <TabsTrigger value="list">
                                    <List aria-hidden />
                                    {t`List`}
                                </TabsTrigger>
                            </TabsList>

                            <TabsContent className="pt-4" value="board">
                                <div className="flex gap-3 overflow-x-auto pb-2">
                                    {STATUS_ORDER.map((status) => {
                                        const column = grouped.get(status) ?? [];
                                        const columnId = `${headingId}-${status}`;

                                        return (
                                            <section aria-labelledby={columnId} className="bg-muted/40 w-72 shrink-0 space-y-2 rounded-lg p-2" key={status}>
                                                <h3 className="flex items-center gap-2 px-1 text-xs font-medium" id={columnId}>
                                                    <TaskStatusIcon status={status} />
                                                    {statusLabels[status]}
                                                    <span className="text-muted-foreground ml-auto tabular-nums">{column.length}</span>
                                                </h3>
                                                {column.length > 0 && (
                                                    <ul className="space-y-2">
                                                        {column.map((task) => (
                                                            <li key={task._id}>{renderCard(task, false)}</li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </section>
                                        );
                                    })}
                                </div>
                            </TabsContent>

                            <TabsContent className="pt-4" value="list">
                                <ul className="space-y-2">
                                    {STATUS_ORDER.flatMap((status) => grouped.get(status) ?? []).map((task) => (
                                        <li key={task._id}>{renderCard(task, true)}</li>
                                    ))}
                                </ul>
                            </TabsContent>
                        </Tabs>
                    </section>
                )
            )}

            <TaskFormDialog
                defaultGoalId={selectedGoalId}
                editingTask={taskDialog.task}
                goals={goals}
                onClose={() => setTaskDialog({ open: false, task: null })}
                onSubmit={async (payload) => {
                    if (taskDialog.task) {
                        await updateTask.mutateAsync({ ...payload, taskId: taskDialog.task._id });
                    } else {
                        await createTask.mutateAsync(payload);
                    }
                }}
                open={taskDialog.open}
                tasks={allTasks}
            />

            <GoalFormDialog
                editingGoal={goalDialog.goal}
                onClose={() => setGoalDialog({ goal: null, open: false })}
                onSubmit={submitGoal}
                open={goalDialog.open}
            />

            <TaskDetailDialog onClose={() => setOpenTaskId(null)} task={openTask} />

            <ConfirmDialog
                confirmLabel={t`Delete`}
                description={
                    pendingDelete?.kind === "goal"
                        ? t`The goal is removed; its tasks stay, without a goal.`
                        : t`The task and its run history are removed. Tasks that depend on it stop waiting for it.`
                }
                loading={deleteTask.isPending || deleteGoal.isPending}
                onConfirm={() => confirmDelete()}
                onOpenChange={(open) => !open && setPendingDelete(null)}
                open={pendingDelete !== null}
                title={pendingDelete?.kind === "goal" ? t`Delete goal "${deleteTitle}"?` : t`Delete task "${deleteTitle}"?`}
            />
        </div>
    );
};

export default TasksPage;
