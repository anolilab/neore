"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { prefillComposer, useComposerTakesPrefill } from "@/features/chat/thread/composer-prefill";

import { catchUpPrompt, catchUpRunId, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "../lib/catch-up-prompt";
import { useBranchComparison, usePullRequest } from "../lib/use-develop";

/**
 * Shows "Behind <base>" and a Catch up button beside an open linked pull request whose branch is behind its base. The button puts a
 * rebase prompt in this thread's composer and sends nothing. Behind is the host's COMPARISON of the head commit with the base
 * branch (`behindBy > 0`), not its mergeability: that says `behind` only where branch protection asks for an up-to-date branch, so a
 * blocked, unstable or clean pull request may be behind too. The comparison is read only for an open, non-draft pull request
 * whose read answered, is keyed by its base branch and head commit, and counts only when it names that same branch and commit:
 * a push or a retarget reads again. Shows nothing while either read has no answer, on a failure (a failed refresh too: a cached
 * "behind" is not known to hold), or once the pull request is merged or closed. A background refresh that has not failed keeps
 * it, so it does not flicker. While it shows, the end of an agent turn in this thread reads the pull request and the comparison
 * again: that turn may have pushed the caught-up branch. Nor for a branch name that is not plain enough to put in a command.
 * Whether the prompt pushes is the host's word on the head's repository, never a guess from names or commits: a fork's branch
 * is not pushed.
 */
const CatchUpControl = ({ isRunning, link, threadId }: { isRunning: boolean; link: { number: number; repository: string }; threadId: string }) => {
    const { t } = useLingui();
    // One run per mounted control: a second click makes the same prompt, and the composer adds the same text only once.
    // A retry of the same run still goes ahead: the fork's local branch takes the next free number instead of stopping.
    const [run] = useState(catchUpRunId);
    const address = { number: link.number, repository: link.repository };
    const pull = usePullRequest(address);
    const detail = pull.data?.status === "ok" ? pull.data.detail : undefined;
    const open = detail?.state === "open" && !detail.draft;
    const comparison = useBranchComparison(address, open ? { baseBranch: detail.baseBranch, headSha: detail.headSha } : undefined);
    const compared = comparison.data?.status === "ok" ? comparison.data : undefined;
    const behind =
        open &&
        !comparison.isError &&
        compared !== undefined &&
        compared.baseBranch === detail.baseBranch &&
        compared.headSha === detail.headSha &&
        compared.behindBy > 0;
    const reread = useEffectEvent(() => {
        if (!behind) {
            return;
        }

        void pull.refetch();
        // The same head after the turn keeps the same key: the base may have moved, so this reads it again too. A new head is a
        // new key, read once the pull request answers with it.
        void comparison.refetch();
    });
    const wasRunning = useRef(isRunning);

    // A turn that ended may have pushed the rebased branch (or merged or closed the pull request): one read, only while it shows.
    useEffect(() => {
        if (wasRunning.current && !isRunning) {
            reread();
        }

        wasRunning.current = isRunning;
    }, [isRunning]);

    if (pull.isError || !behind) {
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
                                    catchUpPrompt({
                                        baseBranch: base,
                                        headBranch: head,
                                        headInBaseRepository: sameRepo,
                                        host,
                                        ...address,
                                        run,
                                    }),
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
const ThreadPullRequestCatchUp = ({ isRunning, link, threadId }: CatchUpProps) =>
    useComposerTakesPrefill(threadId) ? <CatchUpControl isRunning={isRunning} link={link} threadId={threadId} /> : null;

export default ThreadPullRequestCatchUp;
