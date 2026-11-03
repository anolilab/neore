"use client";

/**
 * The chat rendering of a `delegateToSubAgent` tool call: a card with the
 * delegated task, the run's status and a link to the sub-agent's own thread.
 *
 * The run outlives the tool call (which returns as soon as it has started), so
 * the card finds the run by the call's id and follows it through a live query.
 * The result itself is posted to the thread as a separate message. While the
 * run is working the card offers Stop; the child finishes the step it is in
 * (billed) and runs no more.
 *
 * A child that needs a tool its owner set to "ask" waits (`awaiting`), and its
 * request shows here, answered like any approval but on the child's thread.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import type { ToolPart } from "@neore/chat-ui/types";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Bot, CircleStop, ExternalLink, Loader2, ShieldAlert } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import { ToolApprovalCard } from "@/features/chat/thread/tool-approval";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

type RunStatus = "awaiting" | "cancelled" | "failed" | "queued" | "running" | "succeeded";

const TASK_PREVIEW_MAX = 200;

/**
 * The requests a waiting child has open, read only while it waits: one live query per parent conversation, shared by
 * its cards, each showing its own run's. The query answers the parent's owner alone, so whoever sees a request may answer it.
 */
const SubAgentApprovals: FC<{ parentThreadId: string; runId: string }> = ({ parentThreadId, runId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data } = useQuery(crpc.sub_agents.functions.listSubAgentApprovals.queryOptions({ parentThreadId: parentThreadId as Id<"threads"> }));
    const requests = (data ?? []).filter((request) => request.runId === runId);

    return requests.map((request) => {
        const name = request.skillSlug ? `/${request.skillSlug}` : t`The sub-agent`;
        const tool = request.toolName ?? t`a tool`;

        return (
            <div className="mt-2" key={request.approvalId}>
                <ToolApprovalCard
                    approvalId={request.approvalId}
                    canAllowForAPeriod={false}
                    heading={t`${name} wants to run "${tool}"`}
                    input={request.input}
                    isOwner
                    threadId={request.childThreadId}
                    tool={tool}
                />
            </div>
        );
    });
};

const StatusIcon: FC<{ isActive: boolean; isAwaiting: boolean }> = ({ isActive, isAwaiting }) => {
    if (isActive) {
        return <Loader2 aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0 animate-spin motion-reduce:animate-none" />;
    }

    return isAwaiting ? (
        <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
    ) : (
        <Bot aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
    );
};

const SubAgentToolView: FC<{ part: ToolPart }> = ({ part }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { threadId } = useChatThread();
    const headingId = useId();
    const isDenied = part.state === "output-denied";
    const { data: run, isPending } = useQuery(
        crpc.sub_agents.functions.getRunByToolCall.queryOptions(isDenied || !part.toolCallId ? skipToken : { toolCallId: part.toolCallId }),
    );

    const stop = useMutation(
        crpc.sub_agents.functions.cancelRun.mutationOptions({
            onError: (error: unknown) => showError(error instanceof Error ? error : t`Could not stop the sub-agent.`),
        }),
    );

    const input = (typeof part.input === "object" && part.input !== null ? part.input : {}) as { task?: string };
    const task = run?.task ?? input.task ?? "";
    const output = part.state === "output-available" ? (part.output as { error?: string } | undefined) : undefined;

    const statusLabels: Record<RunStatus, string> = {
        awaiting: t`Needs your approval`,
        cancelled: t`Stopped`,
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
    const isAwaiting = run?.status === "awaiting";
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
                <StatusIcon isActive={isActive} isAwaiting={isAwaiting} />
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

            {isAwaiting && threadId && <SubAgentApprovals parentThreadId={threadId} runId={run._id} />}

            {run && (isActive || isAwaiting) && (
                <Button className="mt-2" disabled={stop.isPending} onClick={() => stop.mutate({ runId: run._id })} size="sm" type="button" variant="outline">
                    <CircleStop aria-hidden="true" />
                    {t`Stop`}
                </Button>
            )}

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
