"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { prefillComposer, useComposerTakesPrefill } from "@/features/chat/thread/composer-prefill";

import { catchUpPrompt, catchUpRunId, hostOfPullRequestUrl, isPlainBranchName, isPlainRepo } from "../lib/catch-up-prompt";
import { usePullRequest } from "../lib/use-develop";

/**
 * Shows "Behind <base>" and a Catch up button beside an open linked pull request whose branch is behind its base. The button puts a
 * rebase prompt in this thread's composer and sends nothing. Reads only the pull request, the same cached query as Develop: its
 * state, base, head and the host's mergeability (`mergeState`) all come from that one host response, so they always describe
 * the same revision and no second read is made. Shows only when the host's overall state is `behind`: the host gives one state,
 * and a pull request it reports as blocked or unstable gets no Catch up even when its branch is also behind. Shows nothing while
 * there is no answer, on a failure (a failed refresh too: a cached "behind" is not known to hold), or once the pull request is
 * merged or closed; a draft is not offered Catch up (the host reports a draft as `draft`, never `behind`). A background refresh
 * that has not failed keeps it, so it does not flicker. While it shows, the end of an agent turn in this thread reads the pull
 * request again: that turn may have pushed the caught-up branch. Nor for a branch name that is not plain enough to put in a
 * command. Whether the prompt pushes is the host's word on the head's repository, never a guess from names or commits: a
 * fork's branch is not pushed.
 */
const CatchUpControl = ({ isRunning, link, threadId }: { isRunning: boolean; link: { number: number; repository: string }; threadId: string }) => {
    const { t } = useLingui();
    // One run per mounted control: a second click makes the same prompt, and the composer adds the same text only once.
    const [run] = useState(catchUpRunId);
    const address = { number: link.number, repository: link.repository };
    const pull = usePullRequest(address);
    const detail = pull.data?.status === "ok" ? pull.data.detail : undefined;
    const behind = detail?.state === "open" && !detail.draft && detail.mergeState === "behind";
    const reread = useEffectEvent(() => {
        if (behind) {
            void pull.refetch();
        }
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
