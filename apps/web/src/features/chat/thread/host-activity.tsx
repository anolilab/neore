"use client";

/**
 * What a coding agent on a paired computer is doing while its turn runs (`backend/lunora/acp/lib/activity.ts`): its
 * latest plan as a task list. Live only: the saved reply keeps none of it.
 */

import { useLingui } from "@lingui/react/macro";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { FC } from "react";
import { memo } from "react";

export type HostPlanStatus = "completed" | "in_progress" | "pending";

export interface HostPlanEntry {
    content: string;
    priority: "high" | "low" | "medium";
    status: HostPlanStatus;
}

export interface HostActivityBody {
    plan?: HostPlanEntry[];
}

const StatusIcon: FC<{ status: HostPlanStatus }> = ({ status }) => {
    if (status === "completed") {
        return <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />;
    }

    if (status === "in_progress") {
        return <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin text-blue-600 motion-reduce:animate-none dark:text-blue-400" />;
    }

    return <Circle aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />;
};

/** The agent's plan as a task list; each entry says its status in words, the icon only repeats it. */
export const HostPlan: FC<{ entries: HostPlanEntry[] }> = memo(({ entries }) => {
    const { t } = useLingui();

    if (entries.length === 0) {
        return null;
    }

    const statusText = (status: HostPlanStatus): string => {
        if (status === "completed") {
            return t`Done`;
        }

        return status === "in_progress" ? t`In progress` : t`To do`;
    };

    return (
        <section aria-label={t`The agent's plan`} className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
            <h3 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">{t`Plan`}</h3>
            {/* A styled list loses its list semantics in some browsers, so the role is said out loud. */}
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
            <ul className="flex flex-col gap-1.5" role="list">
                {entries.map((entry, index) => (
                    // Entries carry no id and the plan is replaced whole: position and text together name an entry.
                    <li className="flex items-start gap-2 text-sm" data-status={entry.status} key={`${String(index)}:${entry.content}`}>
                        <StatusIcon status={entry.status} />
                        <span className={entry.status === "completed" ? "text-muted-foreground line-through" : "text-gray-800 dark:text-gray-200"}>
                            {entry.content}
                        </span>
                        <span className="text-muted-foreground ml-auto shrink-0 text-xs">{statusText(entry.status)}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
});

HostPlan.displayName = "HostPlan";

/** Everything the running turn reports, in the order a reader takes it in. */
export const HostActivity: FC<{ activity: HostActivityBody | undefined }> = ({ activity }) => {
    if (activity?.plan === undefined) {
        return null;
    }

    return <HostPlan entries={activity.plan} />;
};
