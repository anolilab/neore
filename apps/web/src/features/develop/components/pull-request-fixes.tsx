"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@neore/ui/components/popover";
import { RefreshCw, TriangleAlert } from "lucide-react";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";

import { prefillComposer } from "@/features/chat/thread/composer-prefill";
import { focusIsLost, useReportFocusLoss } from "@/lib/focus-loss";

import type { FixKind, PullRequestProblems } from "../lib/fix-prompts";
import { buildFixPrompt, fixesFor } from "../lib/fix-prompts";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestStatus } from "../lib/use-develop";

const namesOf = (names: ReadonlyArray<string>, more: number): string => (more > 0 ? `${names.join(", ")} (+${String(more)})` : names.join(", "));

/** Failed reads a retry can help with; a missing connection or access is not fixed by reading again. */
const RETRYABLE = new Set(["host_error", "rate_limited"]);

/** One action in the list; it reports when it goes away holding focus (its problem was fixed while the list was open). */
const FixAction = ({ disabled, label, onClick, onFocusLost }: { disabled: boolean; label: string; onClick: () => void; onFocusLost: () => void }) => {
    const ref = useRef<HTMLButtonElement>(null);

    useReportFocusLoss(onFocusLost, ref);

    return (
        // Focusable while unavailable: a disabled button drops focus to the page.
        <Button aria-busy={disabled} disabled={disabled} focusableWhenDisabled onClick={onClick} ref={ref} size="sm" variant="outline">
            {label}
        </Button>
    );
};

interface RetryButtonProps {
    buttonRef: RefObject<HTMLButtonElement | null>;
    label: string;
    onFocusLost: () => void;
    onRetry: () => void;
    reading: boolean;
}

/** Reads again. Focusable while it reads: a disabled button drops focus to the page. */
const RetryButton = ({ buttonRef, label, onFocusLost, onRetry, reading }: RetryButtonProps) => {
    useReportFocusLoss(onFocusLost, buttonRef);

    return (
        <Button
            aria-busy={reading}
            aria-label={label}
            className="text-muted-foreground size-6"
            disabled={reading}
            focusableWhenDisabled
            onClick={onRetry}
            ref={buttonRef}
            size="icon"
            variant="ghost"
        >
            <RefreshCw aria-hidden className="size-3" />
        </Button>
    );
};

interface FixesListProps {
    chipRef: RefObject<HTMLButtonElement | null>;
    fixes: ReadonlyArray<FixKind>;
    name: string;
    onFocusLost: () => void;
    onOpen: () => void;
    problems: PullRequestProblems;
    /** A read is running: an action waits for it, so its prompt is built from what blocks the pull request now. */
    refreshing: boolean;
    threadId: string;
}

/** The chip and its list. Its own component, so the open state goes when the chip goes and never reopens it later. */
const FixesList = ({ chipRef, fixes, name, onFocusLost, onOpen, problems, refreshing, threadId }: FixesListProps) => {
    const { i18n, t } = useLingui();
    const [open, setOpen] = useState(false);
    const popupRef = useRef<HTMLDivElement>(null);
    const titleRef = useRef<HTMLHeadingElement>(null);
    const actionLostFocus = useRef(false);

    useReportFocusLoss(onFocusLost, chipRef, popupRef);

    // An action that went away holding focus (its problem was fixed): focus stays in the list, on its heading.
    useEffect(() => {
        if (!actionLostFocus.current) {
            return;
        }

        actionLostFocus.current = false;

        if (focusIsLost()) {
            titleRef.current?.focus();
        }
    });

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
                ref={chipRef}
                render={
                    <Button aria-label={t`Problems on ${name}: ${count}`} className="text-destructive h-6 gap-1 px-1.5 text-xs" size="sm" variant="ghost" />
                }
            >
                <TriangleAlert aria-hidden className="size-3" />
                <span aria-hidden>{count}</span>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-80" ref={popupRef}>
                <PopoverTitle className="text-sm font-medium outline-none" ref={titleRef} tabIndex={-1}>{t`What blocks ${name}`}</PopoverTitle>
                <p className="text-muted-foreground mt-1 text-xs">{t`Each action puts a prompt into this chat's message box. Read it, then send it yourself.`}</p>
                <ul className="mt-2 space-y-2">
                    {fixes.map((kind) => (
                        <li className="flex items-center justify-between gap-2" key={kind}>
                            <span className="min-w-0 text-xs break-words">{rows[kind].problem}</span>
                            <FixAction
                                disabled={refreshing}
                                label={rows[kind].action}
                                onClick={() => {
                                    prefillComposer(threadId, buildFixPrompt(kind, problems, i18n));
                                    setOpen(false);
                                }}
                                onFocusLost={() => {
                                    actionLostFocus.current = true;
                                }}
                            />
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
 * action builds its prompt from what blocks the pull request now, not from a read minutes old. When a read removes the
 * focused chip, list or retry, focus moves to what replaced it, or else to `returnFocusTo` (the pull request's link).
 */
const PullRequestFixes = ({
    address,
    readStatus = true,
    returnFocusTo,
    threadId,
}: {
    address: PullRequestAddress;
    /** False when this view does not read the host for the link: the chip then shows the status it already has, if any. */
    readStatus?: boolean;
    returnFocusTo?: RefObject<HTMLElement | null>;
    threadId: string;
}) => {
    const { t } = useLingui();
    const status = usePullRequestStatus(address, threadId, readStatus);
    const { data } = status;
    const name = `${address.repository}#${String(address.number)}`;
    const chipRef = useRef<HTMLButtonElement>(null);
    const retryRef = useRef<HTMLButtonElement>(null);
    const lostFocus = useRef(false);
    const reportLost = () => {
        lostFocus.current = true;
    };

    useEffect(() => {
        if (!lostFocus.current) {
            return;
        }

        lostFocus.current = false;

        if (focusIsLost()) {
            (chipRef.current ?? retryRef.current ?? returnFocusTo?.current)?.focus();
        }
    });

    if (status.isError || (data !== undefined && RETRYABLE.has(data.status))) {
        return (
            <RetryButton
                buttonRef={retryRef}
                label={t`Could not read what blocks ${name}. Try again`}
                onFocusLost={reportLost}
                onRetry={() => {
                    void status.refetch();
                }}
                reading={status.isFetching}
            />
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
            chipRef={chipRef}
            fixes={fixes}
            name={name}
            onFocusLost={reportLost}
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
