"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";

import { prefillComposer, useComposerTakesPrefill } from "@/features/chat/thread/composer-prefill";

import { catchUpPrompt, isPlainBranchName } from "../lib/catch-up-prompt";
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
 * pull request is merged or closed, while the latest read of either failed (a cached "behind" is no longer known to hold), for
 * a branch name that is not plain enough to put in a command, and when the thread has no composer that takes the prompt (a
 * worker's, a comparison's, or a split pane without focus).
 */
const ThreadPullRequestCatchUp = ({ link, threadId }: { link: { number: number; repository: string }; threadId: string }) => {
    const { t } = useLingui();
    const address = { number: link.number, repository: link.repository };
    const pull = usePullRequest(address);
    const detail = pull.data?.status === "ok" ? pull.data.detail : undefined;
    const open = detail?.state === "open";
    const merge = useMergeStatus(address, open);
    const takesPrompt = useComposerTakesPrefill(threadId);

    if (!takesPrompt || !open || pull.isError || merge.isError || merge.data?.status !== "ok" || merge.data.state !== "behind") {
        return null;
    }

    const base = detail.baseBranch;
    const head = detail.headBranch;

    if (!isPlainBranchName(base) || !isPlainBranchName(head)) {
        return null;
    }

    const pullRequest = `${link.repository}#${String(link.number)}`;
    const label = t`Catch up ${pullRequest} with ${base}`;

    return (
        <span className="inline-flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">{t`Behind ${base}`}</span>
            <Tooltip>
                {/* A `render` element replaces the trigger, and TooltipTrigger does not forward its children into it: the label goes in the button. */}
                <TooltipTrigger
                    render={
                        <Button
                            aria-label={label}
                            onClick={() => prefillComposer(threadId, catchUpPrompt({ baseBranch: base, headBranch: head, ...address }))}
                            size="sm"
                            variant="outline"
                        >
                            {t`Catch up`}
                        </Button>
                    }
                />
                <TooltipContent side="bottom">{t`Puts a prompt in the composer to rebase this branch on ${base}, resolve conflicts, check the build and tests, and push. Nothing is sent.`}</TooltipContent>
            </Tooltip>
        </span>
    );
};

export default ThreadPullRequestCatchUp;
