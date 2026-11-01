"use client";

import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { GitPullRequestArrow } from "lucide-react";

import useAfterFirstPaint from "@/hooks/use-after-first-paint";

import { useThreadPullRequest } from "../lib/use-develop";

/**
 * The pull request this thread was attached to, or opened — the other half of the link the pull request's own page
 * shows. Asked for AFTER first paint: a thread that has none needs nothing drawn, and this must not join the burst of
 * queries a chat page opens with.
 */
const ThreadPullRequestLink = ({ threadId }: { threadId: string | undefined }) => {
    const { t } = useLingui();
    const ready = useAfterFirstPaint();
    const link = useThreadPullRequest(ready ? threadId : undefined);

    if (link.data === undefined || link.data === null) {
        return null;
    }

    const { number, repository } = link.data;

    return (
        <Link
            aria-label={t`Open the pull request ${repository}#${number}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
            search={{ number, repository }}
            to="/develop"
        >
            <GitPullRequestArrow aria-hidden className="size-3" />
            <span>
                {repository}#{number}
            </span>
        </Link>
    );
};

export default ThreadPullRequestLink;
