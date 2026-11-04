"use client";

/**
 * What a coding agent on a paired computer is doing while its turn runs (`backend/lunora/acp/lib/activity.ts`): its
 * latest plan as a task list, and its tool calls with the tail of what each printed and, for a command that ran in a
 * terminal, how it exited. Live only: the saved reply keeps none of it.
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

export type HostToolStatus = "cancelled" | "completed" | "declined" | "failed" | "in_progress" | "pending";

export interface HostToolRow {
    exit?: { code?: number; signal?: string };
    id: string;
    output?: string;
    status: HostToolStatus;
    title: string;
    toolKind: string;
}

export interface HostActivityBody {
    plan?: HostPlanEntry[];
    tools?: HostToolRow[];
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

/** One tool call: its title, its status in words, and the tail of what it printed in a region that scrolls on its own. */
const HostToolCall: FC<{ tool: HostToolRow }> = memo(({ tool }) => {
    const { t } = useLingui();
    const { exit, output, status, title } = tool;

    const statusText = (): string => {
        switch (status) {
            case "cancelled": {
                return t`Cancelled`;
            }
            case "completed": {
                return t`Done`;
            }
            case "declined": {
                return t`Declined`;
            }
            case "failed": {
                return t`Failed`;
            }
            case "in_progress": {
                return t`Running`;
            }
            default: {
                return t`Waiting`;
            }
        }
    };

    let exitText: string | undefined;

    if (exit?.code !== undefined) {
        const { code } = exit;

        exitText = t`Exited with code ${code}`;
    } else if (exit?.signal !== undefined) {
        const { signal } = exit;

        exitText = t`Ended by ${signal}`;
    }

    return (
        <li className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-950/40" data-status={status}>
            <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate font-mono text-gray-800 dark:text-gray-200">{title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{statusText()}</span>
            </div>
            {exitText !== undefined && <p className="text-muted-foreground mt-1 text-xs">{exitText}</p>}
            {output !== undefined && output !== "" && (
                // Scrolls on its own, so it takes keyboard focus (a keyboard user could not reach the rest otherwise); the name says
                // whose output it is.
                <pre
                    aria-label={t`Output of ${title}`}
                    className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap text-gray-800 dark:bg-gray-900 dark:text-gray-200"
                    role="region"
                    // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
                    tabIndex={0}
                >
                    {output}
                </pre>
            )}
        </li>
    );
});

HostToolCall.displayName = "HostToolCall";

/** The turn's tool calls, oldest first, each at its latest report. */
export const HostToolCalls: FC<{ tools: HostToolRow[] }> = ({ tools }) => {
    const { t } = useLingui();

    if (tools.length === 0) {
        return null;
    }

    return (
        <section aria-label={t`The agent's tool calls`} className="mb-4">
            <ul className="flex flex-col gap-2">
                {tools.map((tool) => (
                    <HostToolCall key={tool.id} tool={tool} />
                ))}
            </ul>
        </section>
    );
};

/** Everything the running turn reports, in the order a reader takes it in: the plan, then what it ran. */
export const HostActivity: FC<{ activity: HostActivityBody | undefined }> = ({ activity }) => {
    if (activity === undefined) {
        return null;
    }

    return (
        <>
            {activity.plan !== undefined && <HostPlan entries={activity.plan} />}
            {activity.tools !== undefined && <HostToolCalls tools={activity.tools} />}
        </>
    );
};
