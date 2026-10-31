"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Link, useNavigate } from "@tanstack/react-router";
import { GitPullRequestArrow } from "lucide-react";
import { useId, useState } from "react";

import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestThreads, useStartWorkOnPullRequest } from "../lib/use-develop";

/**
 * Work on this PR: opens a thread with the pull request attached, as that thread's first turn — or, when one is
 * already working on it, names it instead of opening a second. Below it, every thread that has worked on this pull
 * request: the one started here, and the ones a coding agent opened it from.
 */
const WorkOnPullRequest = ({ address, requestNoun }: { address: PullRequestAddress; requestNoun: string }) => {
    const { t } = useLingui();
    const navigate = useNavigate();
    const titleId = useId();
    const threads = usePullRequestThreads(address);
    const start = useStartWorkOnPullRequest();
    const [error, setError] = useState<string | null>(null);

    const rows = threads.data ?? [];

    const run = async () => {
        setError(null);

        const result = await start.mutateAsync({ number: address.number, repository: address.repository }).catch(() => undefined);

        if (result === undefined) {
            setError(t`Could not open a thread for this ${requestNoun}. Try again.`);

            return;
        }

        await navigate({ params: { threadId: result.threadId }, to: "/chat/$threadId" });
    };

    return (
        <section aria-labelledby={titleId} className="space-y-3 rounded-md border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-semibold" id={titleId}>
                    {t`Threads working on this ${requestNoun}`}
                </h3>
                <Button disabled={start.isPending} onClick={run} size="sm" variant="outline">
                    <GitPullRequestArrow aria-hidden className="size-4" />
                    {start.isPending ? t`Opening a thread…` : t`Work on this ${requestNoun}`}
                </Button>
            </div>
            <div aria-live="polite" role="status">
                {error !== null && <p className="text-destructive text-sm">{error}</p>}
            </div>
            {threads.isPending && <p className="text-muted-foreground text-xs">{t`Loading threads…`}</p>}
            {threads.isError && (
                <p className="text-destructive text-sm" role="alert">
                    {t`Could not load the threads for this ${requestNoun}.`}
                </p>
            )}
            {!threads.isPending && !threads.isError && rows.length === 0 && (
                <p className="text-muted-foreground text-xs">{t`No thread has worked on this ${requestNoun} yet.`}</p>
            )}
            {rows.length > 0 && (
                <ul className="space-y-1">
                    {rows.map((row) => (
                        <li className="flex flex-wrap items-baseline gap-2 text-sm" key={`${row.kind}-${row.threadId}`}>
                            <Link className="text-primary font-medium underline" params={{ threadId: row.threadId }} to="/chat/$threadId">
                                {row.title}
                            </Link>
                            <span className="text-muted-foreground text-xs">{row.kind === "attached" ? t`Started here` : t`Opened from this thread`}</span>
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
};

export default WorkOnPullRequest;
