"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import cn from "@neore/ui/utils/cn";
import { AlertCircle, CheckCircle2, Circle, CircleDashed, Eye, Loader2, Lock } from "lucide-react";
import type { ComponentType } from "react";

import type { TaskStatus } from "../lib/task-board";

export const useTaskStatusLabels = (): Record<TaskStatus, string> => {
    const { t } = useLingui();

    return {
        blocked: t`Blocked`,
        done: t`Done`,
        failed: t`Failed`,
        needs_review: t`Needs review`,
        queued: t`Queued`,
        running: t`Running`,
        todo: t`To do`,
    };
};

const STATUS_STYLE: Record<TaskStatus, { className: string; icon: ComponentType<{ "aria-hidden"?: boolean; className?: string }> }> = {
    blocked: { className: "text-muted-foreground", icon: Lock },
    done: { className: "text-emerald-600 dark:text-emerald-400", icon: CheckCircle2 },
    failed: { className: "text-destructive", icon: AlertCircle },
    needs_review: { className: "text-amber-600 dark:text-amber-400", icon: Eye },
    queued: { className: "text-sky-600 dark:text-sky-400", icon: CircleDashed },
    running: { className: "text-sky-600 dark:text-sky-400", icon: Loader2 },
    todo: { className: "text-muted-foreground", icon: Circle },
};

export const TaskStatusIcon = ({ className, status }: { className?: string; status: TaskStatus }) => {
    const { className: color, icon: Icon } = STATUS_STYLE[status];

    // The spinner is decorative motion; the global reduced-motion rule stops it.
    return <Icon aria-hidden className={cn("size-3.5 shrink-0", color, status === "running" && "animate-spin", className)} />;
};

export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => {
    const labels = useTaskStatusLabels();

    return (
        <Badge className="gap-1" variant="outline">
            <TaskStatusIcon status={status} />
            {labels[status]}
        </Badge>
    );
};
