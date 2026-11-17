"use client";

/**
 * What a coding agent on a paired computer is doing while its turn runs (`backend/lunora/acp/lib/activity.ts`): its
 * latest plan as a task list, and its tool calls with the tail of what each printed and, for a command that ran in a
 * terminal, how it exited. Live only: the saved reply keeps none of it.
 */

import { useLingui } from "@lingui/react/macro";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { CheckCircle2, Circle, Loader2 } from "lucide-react";
import type { FC } from "react";
import { memo, useLayoutEffect, useRef, useState } from "react";

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
    const { i18n, t } = useLingui();

    if (entries.length === 0) {
        return null;
    }

    /**
     * What is spoken about the plan: the count, singular or plural, and the task in progress when there is one. Each sentence is one
     * translatable message, so a translator orders the whole announcement, not its pieces.
     */
    const announcement = (doneCount: number, totalCount: number, inProgress: string | undefined): string => {
        // The counts in the reader's own number format (a comma, a space or other separator in some locales).
        const numbers = new Intl.NumberFormat(i18n.locale);
        const done = numbers.format(doneCount);
        const total = numbers.format(totalCount);

        if (inProgress === undefined) {
            return totalCount === 1 ? t`${done} of ${total} task done` : t`${done} of ${total} tasks done`;
        }

        return totalCount === 1 ? t`${done} of ${total} task done. In progress: ${inProgress}` : t`${done} of ${total} tasks done. In progress: ${inProgress}`;
    };

    const statusText = (status: HostPlanStatus): string => {
        if (status === "completed") {
            return t`Done`;
        }

        return status === "in_progress" ? t`In progress` : t`To do`;
    };

    const total = entries.length;
    const done = entries.filter((entry) => entry.status === "completed").length;
    const current = entries.find((entry) => entry.status === "in_progress");

    return (
        <section aria-label={t`The agent's plan`} className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/50">
            <h3 className="mb-2 text-xs font-medium text-gray-700 dark:text-gray-300">{t`Plan`}</h3>
            {/* Only the progress is spoken, so a change is announced without reading the whole list again. */}
            <span className="sr-only" role="status">
                {announcement(done, total, current?.content)}
            </span>
            {/* A styled list loses its list semantics in some browsers, so the role is said out loud. */}
            {/* eslint-disable-next-line jsx-a11y/no-redundant-roles */}
            <ul className="flex flex-col gap-1.5" role="list">
                {entries.map((entry, index) => (
                    // Entries carry no id and the plan is replaced whole: position and text together name an entry.
                    <li className="flex items-start gap-2 text-sm" data-status={entry.status} key={`${String(index)}:${entry.content}`}>
                        <StatusIcon status={entry.status} />
                        <span
                            className={`min-w-0 break-words ${entry.status === "completed" ? "text-muted-foreground line-through" : "text-gray-800 dark:text-gray-200"}`}
                        >
                            {entry.content}
                        </span>
                        <span className="text-muted-foreground ms-auto shrink-0 text-xs">{statusText(entry.status)}</span>
                    </li>
                ))}
            </ul>
        </section>
    );
});

HostPlan.displayName = "HostPlan";

const FINISHED: ReadonlySet<HostToolStatus> = new Set(["cancelled", "completed", "declined", "failed"]);

/** A tool call's status and exit in words, and the sentence that announces its outcome. */
const useToolWords = (): {
    announcement: (tool: HostToolRow) => string;
    exitTextOf: (tool: HostToolRow) => string | undefined;
    statusText: (status: HostToolStatus) => string;
} => {
    const { i18n, t } = useLingui();

    const statusText = (status: HostToolStatus): string => {
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

    const exitTextOf = ({ exit }: HostToolRow): string | undefined => {
        if (exit?.code !== undefined) {
            const { code } = exit;

            // The number in the reader's own digits and separators, as the rest of the page shows numbers.
            return t`Exited with code ${formatNumber(code, i18n.locale)}`;
        }

        if (exit?.signal !== undefined) {
            const { signal } = exit;

            return t`Ended by ${signal}`;
        }

        return undefined;
    };

    const announcement = (tool: HostToolRow): string => {
        const { status, title } = tool;
        const exitText = exitTextOf(tool);

        return exitText === undefined ? t`${title}: ${statusText(status)}` : t`${title}: ${statusText(status)}. ${exitText}`;
    };

    return { announcement, exitTextOf, statusText };
};

/** One tool call: its title, its status in words, and the tail of what it printed in a region that scrolls on its own. */
const HostToolCall: FC<{ tool: HostToolRow }> = memo(({ tool }) => {
    const { t } = useLingui();
    const { exitTextOf, statusText } = useToolWords();
    const { output, status, title } = tool;
    const outputRef = useRef<HTMLPreElement>(null);
    const rowRef = useRef<HTMLLIElement>(null);
    // The output is a tail, so it opens at its newest lines; a box the reader scrolled up from keeps its place.
    const followingRef = useRef(true);
    // Whether the reader is in the output box. Removing a focused box drops its focus, so the row takes it instead.
    const inOutputRef = useRef(false);
    const hasOutput = output !== undefined && output !== "";

    useLayoutEffect(() => {
        const box = outputRef.current;

        if (box !== null && followingRef.current) {
            box.scrollTop = box.scrollHeight;
        }
    }, [output]);

    useLayoutEffect(() => {
        if (hasOutput || !inOutputRef.current) {
            return;
        }

        inOutputRef.current = false;
        rowRef.current?.focus();
    }, [hasOutput]);

    const exitText = exitTextOf(tool);

    return (
        <li className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-950/40" data-status={status} ref={rowRef} tabIndex={-1}>
            <div className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 font-mono break-all text-gray-800 dark:text-gray-200">{title}</span>
                <span className="text-muted-foreground shrink-0 text-xs">{statusText(status)}</span>
            </div>
            {exitText !== undefined && <p className="text-muted-foreground mt-1 text-xs">{exitText}</p>}
            {output !== undefined && output !== "" && (
                // Scrolls on its own, so it takes keyboard focus (a keyboard user could not reach the rest otherwise); the name says
                // whose output it is.
                <pre
                    aria-label={t`Output of ${title}`}
                    className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 font-mono text-xs whitespace-pre-wrap text-gray-800 dark:bg-gray-900 dark:text-gray-200"
                    onBlur={() => {
                        inOutputRef.current = false;
                    }}
                    onFocus={() => {
                        inOutputRef.current = true;
                    }}
                    onScroll={(event) => {
                        const box = event.currentTarget;

                        followingRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 8;
                    }}
                    ref={outputRef}
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

/**
 * The turn's tool calls, oldest first, each at its latest report. One status region, mounted with the list, says each call
 * that finishes while it is shown; calls already finished when it mounts (a thread opened mid-turn) are not announced.
 */
export const HostToolCalls: FC<{ tools: HostToolRow[] }> = ({ tools }) => {
    const { t } = useLingui();
    const { announcement } = useToolWords();
    const [announced, setAnnounced] = useState(() => {
        return { finished: new Set(tools.filter((tool) => FINISHED.has(tool.status)).map((tool) => tool.id)), seq: 0, text: "" };
    });
    const newlyFinished = tools.filter((tool) => FINISHED.has(tool.status) && !announced.finished.has(tool.id));

    // Adjusted while rendering (React's sanctioned alternative to an effect that only sets state).
    if (newlyFinished.length > 0) {
        setAnnounced({
            finished: new Set([...announced.finished, ...newlyFinished.map((tool) => tool.id)]),
            seq: announced.seq + 1,
            text: newlyFinished.map((tool) => announcement(tool)).join(" "),
        });
    }

    return (
        <>
            {/* Said once, when a call reaches its outcome; the output streams past it, so it is not part of this announcement. */}
            <span aria-live="polite" className="sr-only" role="status">
                {/* A new element for each announcement: a sentence the same as the last one is still a change the region reads out. */}
                <span key={announced.seq}>{announced.text}</span>
            </span>
            {tools.length > 0 && (
                <section aria-label={t`The agent's tool calls`} className="mb-4">
                    <ul className="flex flex-col gap-2">
                        {tools.map((tool) => (
                            <HostToolCall key={tool.id} tool={tool} />
                        ))}
                    </ul>
                </section>
            )}
        </>
    );
};

/** Everything the running turn reports, in the order a reader takes it in: the plan, then what it ran. */
// Mounted for the whole streaming turn, so a call that finishes after the turn starts is announced; the list waits for its tools.
export const HostActivity: FC<{ activity: HostActivityBody | undefined }> = ({ activity }) => (
    <>
        {activity?.plan !== undefined && <HostPlan entries={activity.plan} />}
        <HostToolCalls tools={activity?.tools ?? []} />
    </>
);
