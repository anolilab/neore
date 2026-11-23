"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@neore/ui/components/popover";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { prefillComposer } from "@/features/chat/thread/composer-prefill";

import type { FixKind, PullRequestProblems } from "../lib/fix-prompts";
import { buildFixPrompt, fixesFor } from "../lib/fix-prompts";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestStatus } from "../lib/use-develop";

const namesOf = (names: ReadonlyArray<string>, more: number): string => (more > 0 ? `${names.join(", ")} (+${String(more)})` : names.join(", "));

/** Failed reads a retry can help with; a missing connection or access is not fixed by reading again. */
const RETRYABLE = new Set(["host_error", "rate_limited"]);

interface FixesListProps {
    fixes: ReadonlyArray<FixKind>;
    name: string;
    onOpen: () => void;
    problems: PullRequestProblems;
    /** A read is running: an action waits for it, so its prompt is built from what blocks the pull request now. */
    refreshing: boolean;
    threadId: string;
}

/** The chip and its list. Its own component, so the open state goes when the chip goes and never reopens it later. */
const FixesList = ({ fixes, name, onOpen, problems, refreshing, threadId }: FixesListProps) => {
    const { i18n, t } = useLingui();
    const [open, setOpen] = useState(false);
    const reviewers = namesOf(
        problems.changeRequests.map((review) => review.authorLogin),
        problems.changeRequestsMore,
    );
    const checks = namesOf(problems.failingChecks, problems.failingChecksMore);
    const base = problems.baseBranch;
    const rows: Record<FixKind, { action: string; problem: string }> = {
        checks: { action: t`Fix checks`, problem: t`Failing checks: ${checks}` },
        conflicts: { action: t`Resolve conflicts`, problem: t`Conflicts with ${base}` },
        review: { action: t`Address review`, problem: t`Changes requested by ${reviewers}` },
    };
    const count = fixes.length;

    return (
        <Popover
            onOpenChange={(next) => {
                setOpen(next);

                if (next) {
                    onOpen();
                }
            }}
            open={open}
        >
            <PopoverTrigger
                render={
                    <Button aria-label={t`Problems on ${name}: ${count}`} className="text-destructive h-6 gap-1 px-1.5 text-xs" size="sm" variant="ghost" />
                }
            >
                <TriangleAlert aria-hidden className="size-3" />
                <span aria-hidden>{count}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80">
                <PopoverTitle className="text-sm font-medium">{t`What blocks ${name}`}</PopoverTitle>
                <p className="text-muted-foreground mt-1 text-xs">{t`Each action puts a prompt into this chat's message box. Read it, then send it yourself.`}</p>
                <ul className="mt-2 space-y-2">
                    {fixes.map((kind) => (
                        <li className="flex items-center justify-between gap-2" key={kind}>
                            <span className="min-w-0 text-xs break-words">{rows[kind].problem}</span>
                            <Button
                                aria-busy={refreshing}
                                disabled={refreshing}
                                onClick={() => {
                                    prefillComposer(threadId, buildFixPrompt(kind, problems, i18n));
                                    setOpen(false);
                                }}
                                size="sm"
                                variant="outline"
                            >
                                {rows[kind].action}
                            </Button>
                        </li>
                    ))}
                </ul>
            </PopoverContent>
        </Popover>
    );
};

/**
 * What blocks one linked open pull request (failing checks, a conflict with its base, requested changes), each with
 * the action that writes a prompt for it into this thread's composer. Nothing is sent: the person reads it and sends
 * it. Shows nothing while the state loads, when nothing blocks the pull request, or when the host cannot be read for a
 * reason reading again does not fix (no connection, no access); a read that failed for a passing reason says so, with a
 * retry, so it never looks like a pull request with nothing in its way. Opening the list reads the state again, so an
 * action builds its prompt from what blocks the pull request now, not from a read minutes old.
 */
const PullRequestFixes = ({ address, threadId }: { address: PullRequestAddress; threadId: string }) => {
    const { t } = useLingui();
    const status = usePullRequestStatus(address);
    const { data } = status;
    const name = `${address.repository}#${String(address.number)}`;

    if (status.isError || (data !== undefined && RETRYABLE.has(data.status))) {
        return (
            <Button
                aria-busy={status.isFetching}
                aria-label={t`Could not read what blocks ${name}. Try again`}
                className="text-muted-foreground size-6"
                disabled={status.isFetching}
                onClick={() => {
                    void status.refetch();
                }}
                size="icon"
                variant="ghost"
            >
                <RefreshCw aria-hidden className="size-3" />
            </Button>
        );
    }

    if (data?.status !== "ok" || data.state !== "open") {
        return null;
    }

    const fixes = fixesFor(data);

    if (fixes.length === 0) {
        return null;
    }

    return (
        <FixesList
            fixes={fixes}
            name={name}
            onOpen={() => {
                void status.refetch();
            }}
            problems={data}
            refreshing={status.isFetching}
            threadId={threadId}
        />
    );
};

export default PullRequestFixes;
