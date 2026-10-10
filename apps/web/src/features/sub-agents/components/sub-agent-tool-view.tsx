"use client";

/**
 * The chat rendering of a `delegateToSubAgent` tool call: a card with the
 * delegated task, the run's status and a link to the sub-agent's own thread.
 *
 * The run outlives the tool call (which returns as soon as it has started), so
 * the card finds the run by the call's id and follows it through a live query.
 * The result itself is posted to the thread as a separate message.
 */

import { useLingui } from "@lingui/react/macro";
import type { ToolPart } from "@neore/chat-ui/types";
import { Badge } from "@neore/ui/components/badge";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, ExternalLink, Loader2 } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

type RunStatus = "failed" | "queued" | "running" | "succeeded";

const TASK_PREVIEW_MAX = 200;

const SubAgentToolView: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const isDenied = part.state === "output-denied";
    const { data: run, isPending } = useQuery(
        crpc.sub_agents.functions.getRunByToolCall.queryOptions(isDenied || !part.toolCallId ? skipToken : { toolCallId: part.toolCallId }),
    );

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as { task?: string };
    const task = run?.task ?? input.task ?? "";
    const output = part.state === "output-available" ? (part.output as { error?: string } | undefined) : undefined;

    const statusLabels: Record<RunStatus, string> = {
        failed: t`Failed`,
        queued: t`Queued`,
        running: t`Working`,
        succeeded: t`Done`,
    };

    // Before the run exists: why it did not start, or that it is starting.
    let notice: string | undefined;

    if (run) {
        notice = run.error ?? undefined;
    } else if (isDenied) {
        notice = t`Sub-agent was not approved.`;
    } else if (output?.error) {
        notice = output.error;
    } else if (part.state === "output-error") {
        notice = part.errorText ?? t`The sub-agent could not start.`;
    } else if (!isPending && part.state === "output-available") {
        notice = t`This sub-agent run is no longer available.`;
    }

    const isStarting = !run && notice === undefined;
    const isActive = isStarting || run?.status === "queued" || run?.status === "running";
    let statusLabel = t`Not started`;

    if (run) {
        statusLabel = statusLabels[run.status];
    } else if (isStarting) {
        statusLabel = t`Starting`;
    }

    const preview = task.length > TASK_PREVIEW_MAX ? `${task.slice(0, TASK_PREVIEW_MAX - 1)}…` : task;

    return (
        <div aria-labelledby={headingId} className="my-2 rounded-lg border p-3 text-sm" role="group">
            <div className="flex items-start gap-2">
                {isActive ? (
                    <Loader2 aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />
                ) : (
                    <Bot aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
                )}
                <div className="min-w-0 flex-1">
                    <p className="font-medium" id={headingId}>
                        {t`Sub-agent`}
                    </p>
                    {preview && <p className="text-muted-foreground mt-0.5 whitespace-pre-wrap">{preview}</p>}
                </div>
                <Badge variant={run?.status === "failed" || (!run && !isStarting) ? "destructive" : "secondary"}>
                    <span aria-live="polite" role="status">
                        {statusLabel}
                    </span>
                </Badge>
            </div>

            {notice && <p className="text-muted-foreground mt-2 text-xs">{notice}</p>}

            {run?.childThreadId && (
                <Link
                    className="text-primary mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                    params={{ threadId: run.childThreadId }}
                    to="/chat/$threadId"
                >
                    <ExternalLink aria-hidden="true" className="size-3" />
                    {t`Open the sub-agent's thread`}
                </Link>
            )}
        </div>
    );
};

export default SubAgentToolView;
