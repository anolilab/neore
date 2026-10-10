"use client";

/**
 * CodingAgentRunView — one coding-agent run (`backend/lunora/coding-agents/`):
 * status, the live log in a collapsible terminal, the summary, the diff, and
 * Cancel / Create PR.
 *
 * Shared by the chat tool call and the task detail dialog. The row is a live
 * query, so the log grows as the runner flushes it. Everything shown came out of
 * a sandbox that ran untrusted code: it is rendered as plain text, never as
 * markdown or HTML, and the backend has already redacted secrets from it.
 */

import { Plural, useLingui } from "@lingui/react/macro";
import type { ReturnOf } from "@lunora/react";
import { api } from "@neore/backend/api";
import { Badge } from "@neore/ui/components/badge";
import { Button, buttonVariants } from "@neore/ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@neore/ui/components/collapsible";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { ChevronRight, CircleStop, ExternalLink, GitPullRequest, Loader2, SquareTerminal } from "lucide-react";
import type { FC } from "react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";

import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { showError, showSuccess } from "@/lib/toast";

import type { DiffLineKind } from "../lib/diff-lines";
import { DIFF_PREVIEW_LINES, diffFiles, parseDiff } from "../lib/diff-lines";

export type CodingAgentRun = NonNullable<ReturnOf<typeof api.coding_agents.functions.getRun>>;

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
    added: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
    context: "text-muted-foreground",
    file: "mt-2 font-semibold text-foreground first:mt-0",
    hunk: "text-sky-700 dark:text-sky-300",
    meta: "text-muted-foreground/70",
    removed: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

const DiffViewer: FC<{ diff: string }> = memo(({ diff }) => {
    const { t } = useLingui();
    const [showAll, setShowAll] = useState(false);
    const lines = useMemo(() => parseDiff(diff), [diff]);
    const visible = showAll ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
    const hidden = lines.length - visible.length;

    return (
        <div>
            <pre className="bg-muted/40 max-h-96 overflow-auto rounded-md p-2 font-mono text-xs leading-5">
                {visible.map((line, index) => (
                    // Lines have no identity beyond their position in an immutable diff.
                    // eslint-disable-next-line react-x/no-array-index-key
                    <div className={cn("px-1 whitespace-pre", DIFF_LINE_CLASS[line.kind])} key={index}>
                        {line.text || " "}
                    </div>
                ))}
            </pre>
            {hidden > 0 && (
                <Button className="mt-1" onClick={() => setShowAll(true)} size="sm" variant="ghost">
                    {t`Show ${hidden} more lines`}
                </Button>
            )}
        </div>
    );
});

DiffViewer.displayName = "DiffViewer";

/** The terminal-style log. Pinned to the bottom while the run streams, unless the user scrolled up. */
const RunLog: FC<{ isLive: boolean; log: string }> = ({ isLive, log }) => {
    const { t } = useLingui();
    const ref = useRef<HTMLPreElement>(null);
    const pinned = useRef(true);

    useEffect(() => {
        const element = ref.current;

        if (element && isLive && pinned.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [isLive, log]);

    return (
        <pre
            aria-label={t`Coding agent log`}
            // The status line announces progress; announcing every log line would drown it.
            aria-live="off"
            className="max-h-80 overflow-auto rounded-md bg-zinc-950 p-3 font-mono text-xs leading-5 whitespace-pre-wrap text-zinc-100"
            onScroll={(event) => {
                const element = event.currentTarget;

                pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
            }}
            ref={ref}
            role="log"
            // Scrollable region must be reachable by keyboard.
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
            tabIndex={0}
        >
            {log || t`Waiting for output…`}
        </pre>
    );
};

const AGENT_LABEL: Record<CodingAgentRun["agent"], string> = { claude_code: "Claude Code", codex: "OpenAI Codex" };

const GITHUB_PREFIX = /^https:\/\/(?:www\.)?github\.com\//u;
const DOT_GIT_SUFFIX = /\.git$/u;

const repoLabel = (repoUrl: string): string => repoUrl.replace(GITHUB_PREFIX, "").replace(DOT_GIT_SUFFIX, "");

const STATUS_VARIANT: Record<CodingAgentRun["status"], "default" | "destructive" | "secondary"> = {
    cancelled: "secondary",
    failed: "destructive",
    queued: "secondary",
    running: "secondary",
    succeeded: "default",
};

interface CodingAgentRunViewProps {
    className?: string;
    run: CodingAgentRun;
}

const CodingAgentRunView: FC<CodingAgentRunViewProps> = ({ className, run }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const isLive = run.status === "queued" || run.status === "running";
    const [logOpen, setLogOpen] = useState(isLive);
    const [diffOpen, setDiffOpen] = useState(false);
    const files = useMemo(() => (run.diff ? diffFiles(run.diff) : []), [run.diff]);
    const agentLabel = AGENT_LABEL[run.agent];
    const repo = repoLabel(run.repoUrl);
    const fileCount = files.length;

    const cancel = useMutation(
        crpc.coding_agents.functions.cancelRun.mutationOptions({
            onError: (error: unknown) => showError(error instanceof Error ? error : t`Could not cancel the run.`),
        }),
    );
    const createPr = useMutation(useLunoraActionOptions(api.coding_agents.execute.createPullRequest));

    const openPullRequest = () => {
        createPr.mutate(
            { runId: run._id },
            {
                onError: (error) => showError(error instanceof Error ? error : t`Could not open the pull request.`),
                onSuccess: (result) => {
                    if ("error" in result) {
                        showError(result.error);
                    } else {
                        showSuccess(t`Opening a pull request — progress is in the log`);
                    }
                },
            },
        );
    };

    const statusLabel: Record<CodingAgentRun["status"], string> = {
        cancelled: t`Cancelled`,
        failed: t`Failed`,
        queued: t`Starting…`,
        running: t`Working…`,
        succeeded: t`Done`,
    };

    return (
        <section aria-labelledby={headingId} className={cn("my-2 w-full max-w-3xl rounded-lg border p-3", className)}>
            <header className="flex flex-wrap items-center gap-2">
                <SquareTerminal aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                <h3 className="min-w-0 flex-1 truncate text-sm font-medium" id={headingId}>
                    {t`${agentLabel} on ${repo}`}
                    {run.baseBranch ? <span className="text-muted-foreground font-normal">{` · ${run.baseBranch}`}</span> : null}
                </h3>
                <Badge aria-live="polite" role="status" variant={STATUS_VARIANT[run.status]}>
                    {isLive && <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />}
                    {statusLabel[run.status]}
                </Badge>
            </header>

            <p className="text-muted-foreground mt-1 line-clamp-2 text-xs">{run.prompt}</p>

            {run.error && run.status !== "cancelled" && (
                <p className="text-destructive mt-2 text-sm whitespace-pre-wrap" role="alert">
                    {run.error}
                </p>
            )}

            {run.summary && <p className="mt-2 text-sm whitespace-pre-wrap">{run.summary}</p>}

            <Collapsible className="mt-3" onOpenChange={setLogOpen} open={logOpen}>
                <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium">
                    <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", logOpen && "rotate-90")} />
                    {t`Log`}
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-1">
                    <RunLog isLive={isLive} log={run.log} />
                </CollapsibleContent>
            </Collapsible>

            {run.diff ? (
                <Collapsible className="mt-2" onOpenChange={setDiffOpen} open={diffOpen}>
                    <CollapsibleTrigger className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium">
                        <ChevronRight
                            aria-hidden="true"
                            className={cn("size-3.5 transition-transform motion-reduce:transition-none", diffOpen && "rotate-90")}
                        />
                        <Plural one="Changes (# file)" other="Changes (# files)" value={fileCount} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="mt-1">
                        {run.diffTruncated && <p className="text-muted-foreground mb-1 text-xs">{t`The change is too large to show in full.`}</p>}
                        <DiffViewer diff={run.diff} />
                    </CollapsibleContent>
                </Collapsible>
            ) : (
                run.status === "succeeded" && <p className="text-muted-foreground mt-2 text-xs">{t`The agent made no file changes.`}</p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {isLive && (
                    <Button disabled={cancel.isPending} onClick={() => cancel.mutate({ runId: run._id })} size="sm" variant="outline">
                        <CircleStop aria-hidden="true" />
                        {t`Cancel`}
                    </Button>
                )}
                {run.prPending && (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-xs" role="status">
                        <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />
                        {t`Opening pull request…`}
                    </span>
                )}
                {run.canOpenPr && (
                    <Button disabled={createPr.isPending} onClick={openPullRequest} size="sm">
                        {createPr.isPending ? (
                            <Loader2 aria-hidden="true" className="animate-spin motion-reduce:animate-none" />
                        ) : (
                            <GitPullRequest aria-hidden="true" />
                        )}
                        {t`Create PR`}
                    </Button>
                )}
                {run.prUrl?.startsWith("https://github.com/") && (
                    <a className={buttonVariants({ size: "sm", variant: "outline" })} href={run.prUrl} rel="noopener noreferrer" target="_blank">
                        <ExternalLink aria-hidden="true" />
                        {t`View pull request`}
                        <span className="sr-only">{t`(opens in a new tab)`}</span>
                    </a>
                )}
            </div>
        </section>
    );
};

export default CodingAgentRunView;
