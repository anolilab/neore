"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";

import type { EvalRun } from "../lib/evals-format";

export const useRunStatusLabels = (): Record<EvalRun["status"], string> => {
    const { t } = useLingui();

    return {
        cancelled: t`Cancelled`,
        completed: t`Completed`,
        cost_capped: t`Stopped at budget`,
        failed: t`Failed`,
        running: t`Running`,
    };
};

const STATUS_VARIANT: Record<EvalRun["status"], "default" | "destructive" | "outline" | "secondary"> = {
    cancelled: "secondary",
    completed: "default",
    cost_capped: "secondary",
    failed: "destructive",
    running: "outline",
};

export const RunStatusBadge = ({ status }: { status: EvalRun["status"] }) => {
    const labels = useRunStatusLabels();

    return <Badge variant={STATUS_VARIANT[status]}>{labels[status]}</Badge>;
};
