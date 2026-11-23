"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";

import { prefillComposer, useComposerTakesPrefill } from "@/features/chat/thread/composer-prefill";

import { catchUpPrompt, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "../lib/catch-up-prompt";
import { usePullRequest } from "../lib/use-develop";
import { useMergeStatus } from "../lib/use-merge";

/**
 * Shows "Behind <base>" and a Catch up button beside an open linked pull request whose branch is behind its base. The button puts a
 * rebase prompt in this thread's composer and sends nothing. Reads the same cached queries as Develop: the pull request
 * (open, and its base), then the host's mergeability once it is open. Shows nothing while loading, on a failure, or once the
 * pull request is merged or closed, while the latest read of either failed (a cached "behind" is no longer known to hold), for
 * a branch name that is not plain enough to put in a command. Whether the prompt pushes is the host's word on the head's
 * repository, never a guess from names or commits: a fork's branch is not pushed.
 */
const CatchUpControl = ({ link, threadId }: { link: { number: number; repository: string }; threadId: string }) => {
    const { t } = useLingui();
    const address = { number: link.number, repository: link.repository };
    const pull = usePullRequest(address);
    const detail = pull.data?.status === "ok" ? pull.data.detail : undefined;
    const open = detail?.state === "open";
    const merge = useMergeStatus(address, open);

    if (!open || pull.isError || merge.isError || merge.data?.status !== "ok" || merge.data.state !== "behind") {
        return null;
    }

    const base = detail.baseBranch;
    const head = detail.headBranch;

    const host = hostOfPullRequestUrl(detail.url);

    if (!isPlainBranchName(base) || !isPlainBranchName(head) || !isPlainRepo(link.repository) || host === undefined) {
        return null;
    }

    const pullRequest = `${link.repository}#${String(link.number)}`;
    const label = t`Catch up ${pullRequest} with ${base}`;
    // Strictly `true`: a detail from before the host reported it reads as a fork, which is never pushed to.
    const sameRepo = detail.headInBaseRepository === true;

    return (
        <span className="inline-flex items-center gap-1 text-xs">
            <span className="text-muted-foreground">{t`Behind ${base}`}</span>
            <Tooltip>
                {/* A `render` element replaces the trigger, and TooltipTrigger does not forward its children into it: the label goes in the button. */}
                <TooltipTrigger
                    render={
                        <Button
                            aria-label={label}
                            onClick={() =>
                                prefillComposer(
                                    threadId,
                                    catchUpPrompt({ baseBranch: base, headBranch: head, headInBaseRepository: sameRepo, host, ...address }),
                                )
                            }
                            size="sm"
                            variant="outline"
                        >
                            {t`Catch up`}
                        </Button>
                    }
                />
                <TooltipContent side="bottom">
                    {sameRepo
                        ? t`Puts a prompt in the composer to rebase this branch on ${base}, resolve conflicts, check the build and tests, and push. Nothing is sent.`
                        : t`Puts a prompt in the composer to rebase this fork's branch on ${base} in a local copy, resolve conflicts, and check the build and tests. It is not pushed. Nothing is sent.`}
                </TooltipContent>
            </Tooltip>
        </span>
    );
};

type CatchUpProps = Parameters<typeof CatchUpControl>[0];

/**
 * Mounts the control, and with it its host reads, only where the thread has a composer on the page that takes the prompt
 * (`useComposerPrefill`): a split pane without focus, or a thread whose composer is not shown, reads nothing.
 */
const ThreadPullRequestCatchUp = ({ link, threadId }: CatchUpProps) =>
    useComposerTakesPrefill(threadId) ? <CatchUpControl link={link} threadId={threadId} /> : null;

export default ThreadPullRequestCatchUp;
