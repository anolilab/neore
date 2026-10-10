"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { useId, useMemo, useState } from "react";
import { toast } from "sonner";

import PromptModelSelector from "@/features/prompts/components/prompt-model-selector";
import { useCRPC } from "@/lib/lunora/crpc";

import type { BoardGoal, BoardTask, SchedulePresetKey, TaskAssignee, TaskFormErrorKey, TaskFormValues } from "../lib/task-board";
import {
    CRITERIA_MAX,
    getTaskFormDefaults,
    INSTRUCTIONS_MAX,
    MAX_REPAIR_ROUNDS,
    presetForCron,
    SCHEDULE_PRESETS,
    selectableRelatives,
    TITLE_MAX,
    toTaskPayload,
    validateTaskForm,
} from "../lib/task-board";

const NONE = "__none__";

interface TaskFormDialogProps {
    /** Pre-selects this goal for a new task. */
    defaultGoalId?: Id<"goals"> | null;
    editingTask?: BoardTask | null;
    goals: ReadonlyArray<BoardGoal>;
    onClose: () => void;
    onSubmit: (payload: ReturnType<typeof toTaskPayload>) => Promise<void>;
    open: boolean;
    tasks: ReadonlyArray<BoardTask>;
}

type BodyProps = Omit<TaskFormDialogProps, "open">;

const TaskFormDialogBody = ({ defaultGoalId, editingTask, goals, onClose, onSubmit, tasks }: BodyProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    const [values, setValues] = useState<TaskFormValues>(() => getTaskFormDefaults(editingTask, defaultGoalId));
    const [preset, setPreset] = useState<SchedulePresetKey>(() => presetForCron(values.cronExpression));
    const [submitted, setSubmitted] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const { data: skills = [] } = useQuery(crpc.tasks.functions.listTaskSkillOptions.queryOptions({}));

    const errors = validateTaskForm(values);
    const hasErrors = Object.keys(errors).length > 0;
    const relatives = useMemo(() => selectableRelatives(tasks, editingTask?._id), [tasks, editingTask?._id]);

    const messageFor = (key: TaskFormErrorKey | undefined): string | undefined => {
        switch (key) {
            case "criteriaTooLong": {
                return t`Success criteria must be ${CRITERIA_MAX} characters or less`;
            }
            case "cronInvalid": {
                return t`Use five cron fields, e.g. "0 9 * * 1" for Mondays at 09:00 UTC`;
            }
            case "instructionsRequired": {
                return t`Instructions are required`;
            }
            case "instructionsTooLong": {
                return t`Instructions must be ${INSTRUCTIONS_MAX} characters or less`;
            }
            case "repoInvalid": {
                return t`Use an https:// git URL or GitHub owner/repo`;
            }
            case "repoRequired": {
                return t`A coding agent needs a repository to work on`;
            }
            case "titleRequired": {
                return t`Title is required`;
            }
            case "titleTooLong": {
                return t`Title must be ${TITLE_MAX} characters or less`;
            }
            default: {
                return undefined;
            }
        }
    };

    const set = <K extends keyof TaskFormValues>(key: K, value: TaskFormValues[K]) =>
        setValues((previous) => {
            return { ...previous, [key]: value };
        });

    const presetLabels: Record<SchedulePresetKey, string> = {
        custom: t`Custom (cron)`,
        daily: t`Every day at 09:00 UTC`,
        hourly: t`Every hour`,
        none: t`Does not repeat`,
        weekdays: t`Weekdays at 09:00 UTC`,
        weekly: t`Mondays at 09:00 UTC`,
    };

    const assigneeLabels: Record<TaskAssignee, string> = {
        chat: t`Chat agent`,
        claude_code: t`Claude Code (coding agent)`,
        codex: t`OpenAI Codex (coding agent)`,
    };
    const isCodingAgent = values.assignee !== "chat";
    const keyProvider = values.assignee === "codex" ? "OpenAI" : "Anthropic";

    const fieldError = (key: keyof TaskFormValues) => (submitted ? messageFor(errors[key]) : undefined);
    const ids = {
        assignee: `${baseId}-assignee`,
        assigneeHint: `${baseId}-assignee-hint`,
        branch: `${baseId}-branch`,
        criteria: `${baseId}-criteria`,
        cron: `${baseId}-cron`,
        cronError: `${baseId}-cron-error`,
        dependencies: `${baseId}-dependencies`,
        goal: `${baseId}-goal`,
        instructions: `${baseId}-instructions`,
        instructionsError: `${baseId}-instructions-error`,
        model: `${baseId}-model`,
        parent: `${baseId}-parent`,
        repairs: `${baseId}-repairs`,
        repairsHint: `${baseId}-repairs-hint`,
        repo: `${baseId}-repo`,
        repoError: `${baseId}-repo-error`,
        schedule: `${baseId}-schedule`,
        skill: `${baseId}-skill`,
        title: `${baseId}-title`,
        titleError: `${baseId}-title-error`,
    };

    const handleSubmit = async () => {
        setSubmitted(true);

        if (hasErrors) {
            return;
        }

        setIsSubmitting(true);

        try {
            await onSubmit(toTaskPayload(values));
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to save task`);
        } finally {
            setIsSubmitting(false);
        }
    };

    const titleError = fieldError("title");
    const instructionsError = fieldError("instructions");
    const cronError = fieldError("cronExpression");
    const repoError = fieldError("repoUrl");

    return (
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{editingTask ? t`Edit task` : t`New task`}</DialogTitle>
                <DialogDescription>{t`An agent works the task on its own, then a verifier checks the result against your success criteria.`}</DialogDescription>
            </DialogHeader>
            <form
                autoComplete="off"
                className="contents"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmit();
                }}
            >
                <DialogPanel className="max-h-[65vh] min-h-0 flex-1 overflow-y-auto">
                    <div className="space-y-5">
                        <div className="space-y-2">
                            <Label htmlFor={ids.title}>{t`Title`}</Label>
                            <Input
                                aria-describedby={titleError ? ids.titleError : undefined}
                                aria-invalid={!!titleError}
                                id={ids.title}
                                maxLength={TITLE_MAX}
                                onChange={(event) => set("title", event.target.value)}
                                required
                                value={values.title}
                            />
                            {titleError && (
                                <p className="text-destructive text-xs" id={ids.titleError}>
                                    {titleError}
                                </p>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor={ids.instructions}>{t`Instructions`}</Label>
                            <Textarea
                                aria-describedby={instructionsError ? ids.instructionsError : undefined}
                                aria-invalid={!!instructionsError}
                                className="min-h-28"
                                id={ids.instructions}
                                onChange={(event) => set("instructions", event.target.value)}
                                placeholder={t`What should the agent do?`}
                                required
                                value={values.instructions}
                            />
                            {instructionsError && (
                                <p className="text-destructive text-xs" id={ids.instructionsError}>
                                    {instructionsError}
                                </p>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label htmlFor={ids.criteria}>{t`Success criteria`}</Label>
                            <Textarea
                                aria-describedby={`${ids.criteria}-hint`}
                                id={ids.criteria}
                                onChange={(event) => set("successCriteria", event.target.value)}
                                placeholder={t`e.g. Lists at least five sources, each with a link`}
                                value={values.successCriteria}
                            />
                            <p className="text-muted-foreground text-xs" id={`${ids.criteria}-hint`}>
                                {fieldError("successCriteria") ?? t`The verifier passes the result only if every criterion is met.`}
                            </p>
                        </div>

                        <div className="space-y-2">
                            <Label id={ids.assignee}>{t`Assigned to`}</Label>
                            <Select
                                items={(Object.keys(assigneeLabels) as TaskAssignee[]).map((key) => {
                                    return { label: assigneeLabels[key], value: key };
                                })}
                                onValueChange={(value) => set("assignee", (value ?? "chat") as TaskAssignee)}
                                value={values.assignee}
                            >
                                <SelectTrigger aria-describedby={ids.assigneeHint} aria-labelledby={ids.assignee}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {(Object.keys(assigneeLabels) as TaskAssignee[]).map((key) => (
                                        <SelectItem key={key} value={key}>
                                            {assigneeLabels[key]}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <p className="text-muted-foreground text-xs" id={ids.assigneeHint}>
                                {isCodingAgent
                                    ? t`Runs in a cloud sandbox for up to 20 minutes on your own ${keyProvider} API key (Settings → API keys). Private GitHub repositories need the GitHub connector.`
                                    : t`The chat agent works the task with its tools, optionally following a skill.`}
                            </p>
                        </div>

                        {isCodingAgent && (
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor={ids.repo}>{t`Repository`}</Label>
                                    <Input
                                        aria-describedby={repoError ? ids.repoError : undefined}
                                        aria-invalid={!!repoError}
                                        className="font-mono"
                                        id={ids.repo}
                                        onChange={(event) => set("repoUrl", event.target.value)}
                                        placeholder="owner/repo"
                                        required
                                        value={values.repoUrl}
                                    />
                                    {repoError && (
                                        <p className="text-destructive text-xs" id={ids.repoError}>
                                            {repoError}
                                        </p>
                                    )}
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor={ids.branch}>{t`Branch`}</Label>
                                    <Input
                                        className="font-mono"
                                        id={ids.branch}
                                        onChange={(event) => set("branch", event.target.value)}
                                        placeholder={t`Default branch`}
                                        value={values.branch}
                                    />
                                </div>
                                <Label className="flex cursor-pointer items-center gap-2 font-normal sm:col-span-2">
                                    <Checkbox checked={values.openPr} onCheckedChange={(next) => set("openPr", next === true)} />
                                    {t`Open a pull request with the change (GitHub, needs the GitHub connector)`}
                                </Label>
                            </div>
                        )}

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2" hidden={isCodingAgent}>
                                <Label id={ids.skill}>{t`Agent`}</Label>
                                <Select
                                    items={[
                                        { label: t`Default agent`, value: NONE },
                                        ...skills.map((skill) => {
                                            return { label: `/${skill.slug} — ${skill.name}`, value: skill._id as string };
                                        }),
                                    ]}
                                    onValueChange={(value) => set("skillId", !value || value === NONE ? "" : (String(value) as Id<"skills">))}
                                    value={values.skillId || NONE}
                                >
                                    <SelectTrigger aria-labelledby={ids.skill}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>{t`Default agent`}</SelectItem>
                                        {skills.map((skill) => (
                                            <SelectItem key={skill._id} value={skill._id}>
                                                {`/${skill.slug} — ${skill.name}`}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label id={ids.goal}>{t`Goal`}</Label>
                                <Select
                                    items={[
                                        { label: t`No goal`, value: NONE },
                                        ...goals.map((goal) => {
                                            return { label: goal.title, value: goal._id as string };
                                        }),
                                    ]}
                                    onValueChange={(value) => set("goalId", !value || value === NONE ? "" : (String(value) as Id<"goals">))}
                                    value={values.goalId || NONE}
                                >
                                    <SelectTrigger aria-labelledby={ids.goal}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={NONE}>{t`No goal`}</SelectItem>
                                        {goals.map((goal) => (
                                            <SelectItem key={goal._id} value={goal._id}>
                                                {goal.title}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>

                        <div aria-labelledby={ids.model} className="space-y-2" hidden={isCodingAgent} role="group">
                            <Label id={ids.model}>{t`Model`}</Label>
                            <PromptModelSelector onChange={(model) => set("model", model)} value={values.model} />
                            <div className="flex items-center justify-between gap-2">
                                <p className="text-muted-foreground text-xs">{t`Optional. Defaults to the skill's preferred model, then the default model.`}</p>
                                {values.model && (
                                    <Button onClick={() => set("model", undefined)} size="sm" type="button" variant="ghost">
                                        {t`Clear model`}
                                    </Button>
                                )}
                            </div>
                        </div>

                        <div className="space-y-2">
                            <Label id={ids.parent}>{t`Subtask of`}</Label>
                            <Select
                                items={[
                                    { label: t`None (top-level task)`, value: NONE },
                                    ...relatives.map((task) => {
                                        return { label: task.title, value: task._id as string };
                                    }),
                                ]}
                                onValueChange={(value) => set("parentTaskId", !value || value === NONE ? "" : (String(value) as Id<"tasks">))}
                                value={values.parentTaskId || NONE}
                            >
                                <SelectTrigger aria-labelledby={ids.parent}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value={NONE}>{t`None (top-level task)`}</SelectItem>
                                    {relatives.map((task) => (
                                        <SelectItem key={task._id} value={task._id}>
                                            {task.title}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <fieldset className="space-y-2">
                            <legend className="text-sm font-medium" id={ids.dependencies}>
                                {t`Depends on`}
                            </legend>
                            <p className="text-muted-foreground text-xs">{t`The task waits until every selected task is done.`}</p>
                            {relatives.length === 0 ? (
                                <p className="text-muted-foreground text-xs">{t`No other tasks yet.`}</p>
                            ) : (
                                <ul className="border-border max-h-40 space-y-1 overflow-y-auto rounded-md border p-2">
                                    {relatives.map((task) => {
                                        const checked = values.dependsOn.includes(task._id);

                                        return (
                                            <li key={task._id}>
                                                <Label className="flex cursor-pointer items-center gap-2 font-normal">
                                                    <Checkbox
                                                        checked={checked}
                                                        onCheckedChange={(next) =>
                                                            set(
                                                                "dependsOn",
                                                                next ? [...values.dependsOn, task._id] : values.dependsOn.filter((id) => id !== task._id),
                                                            )
                                                        }
                                                    />
                                                    <span className="truncate">{task.title}</span>
                                                </Label>
                                            </li>
                                        );
                                    })}
                                </ul>
                            )}
                        </fieldset>

                        <div className="grid gap-4 sm:grid-cols-2">
                            <div className="space-y-2">
                                <Label id={ids.schedule}>{t`Repeat`}</Label>
                                <Select
                                    items={(["none", ...SCHEDULE_PRESETS.map((entry) => entry.key), "custom"] as SchedulePresetKey[]).map((key) => {
                                        return { label: presetLabels[key], value: key };
                                    })}
                                    onValueChange={(value) => {
                                        const next = (value ?? "none") as SchedulePresetKey;

                                        setPreset(next);

                                        if (next === "none") {
                                            set("cronExpression", "");
                                        } else if (next !== "custom") {
                                            set("cronExpression", SCHEDULE_PRESETS.find((entry) => entry.key === next)?.cron ?? "");
                                        }
                                    }}
                                    value={preset}
                                >
                                    <SelectTrigger aria-labelledby={ids.schedule}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {(["none", ...SCHEDULE_PRESETS.map((entry) => entry.key), "custom"] as SchedulePresetKey[]).map((key) => (
                                            <SelectItem key={key} value={key}>
                                                {presetLabels[key]}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                                {preset === "custom" && (
                                    <div className="space-y-1">
                                        <Label className="sr-only" htmlFor={ids.cron}>
                                            {t`Cron expression (UTC)`}
                                        </Label>
                                        <Input
                                            aria-describedby={cronError ? ids.cronError : undefined}
                                            aria-invalid={!!cronError}
                                            className="font-mono"
                                            id={ids.cron}
                                            onChange={(event) => set("cronExpression", event.target.value)}
                                            placeholder="0 9 * * 1"
                                            value={values.cronExpression}
                                        />
                                        {cronError && (
                                            <p className="text-destructive text-xs" id={ids.cronError}>
                                                {cronError}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor={ids.repairs}>{t`Repair rounds`}</Label>
                                <Input
                                    aria-describedby={ids.repairsHint}
                                    id={ids.repairs}
                                    max={MAX_REPAIR_ROUNDS}
                                    min={0}
                                    onChange={(event) => {
                                        const parsed = Number.parseInt(event.target.value, 10);

                                        set("maxRepairRounds", Number.isNaN(parsed) ? 0 : Math.min(Math.max(parsed, 0), MAX_REPAIR_ROUNDS));
                                    }}
                                    type="number"
                                    value={values.maxRepairRounds}
                                />
                                <p className="text-muted-foreground text-xs" id={ids.repairsHint}>
                                    {t`How often the agent retries with the verifier's feedback before asking you to review.`}
                                </p>
                            </div>
                        </div>
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={isSubmitting} disabled={isSubmitting} type="submit">
                        {editingTask ? t`Save changes` : t`Create task`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const TaskFormDialog = ({ open, ...props }: TaskFormDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <TaskFormDialogBody key={props.editingTask?._id ?? "new"} {...props} />}
    </Dialog>
);

export default TaskFormDialog;
