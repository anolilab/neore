"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";

import { prefillComposer } from "@/features/chat/thread/composer-prefill";

import { catchUpPrompt } from "../lib/catch-up-prompt";
import { usePullRequest } from "../lib/use-develop";
import { useMergeStatus } from "../lib/use-merge";

/**
 * How many of a thread's linked pull requests (newest first) are checked for being behind: each check is up to three
 * host reads, cached a minute and shared with Develop, so a thread with many links does not spend the host's budget.
 */
export const CATCH_UP_CHECKED_LINKS = 5;

/**
 * Shows "Behind <base>" and a Catch up button beside an open linked pull request whose branch is behind its base. The button puts a
 * rebase prompt in this thread's composer and sends nothing. Reads the same cached queries as Develop: the pull request
 * (open, and its base), then the host's mergeability once it is open. Shows nothing while loading, on a failure, or once the
 * pull request is merged or closed.
 */
const ThreadPullRequestCatchUp = ({ link, threadId }: { link: { number: number; repository: string }; threadId: string }) => {
    const { t } = useLingui();
    const address = { number: link.number, repository: link.repository };
    const pull = usePullRequest(address);
    const detail = pull.data?.status === "ok" ? pull.data.detail : undefined;
    const open = detail?.state === "open";
    const merge = useMergeStatus(address, open);

    if (!open || merge.data?.status !== "ok" || merge.data.state !== "behind") {
        return null;
    }

    const base = detail.baseBranch;
    const pullRequest = `${link.repository}#${String(link.number)}`;
    const label = t`Catch up ${pullRequest} with ${base}`;

    return (
        <span className="inline-flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">{t`Behind ${base}`}</span>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button
                            aria-label={label}
                            onClick={() => prefillComposer(threadId, catchUpPrompt({ baseBranch: base, ...address }))}
                            size="sm"
                            variant="outline"
                        />
                    }
                >
                    {t`Catch up`}
                </TooltipTrigger>
                <TooltipContent side="bottom">{t`Puts a prompt in the composer to rebase this branch on ${base}, resolve conflicts, check the build and tests, and push. Nothing is sent.`}</TooltipContent>
            </Tooltip>
        </span>
    );
};

export default ThreadPullRequestCatchUp;
