"use client";

/**
 * Shown under a reply whose run is waiting out a provider's rate limit: who limited it, a live countdown, and the two
 * things a person can do — end the wait now, or stop the reply. The run resumes by itself at the retry time. Everyone who
 * can see the reply sees the countdown; the two buttons are for people who may write to the thread.
 *
 * Screen readers: the ticking `m:ss` is hidden from them (it would be read every second). A polite status region holds
 * the same sentence with the time rounded up to half a minute, so it speaks when the pause starts, every thirty seconds,
 * and once more when the wait is over.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { RefreshCw, Square } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import { announcedWaitMs, formatCountdown, providerLabel } from "./rate-limit-pause";

/** The pause `getActiveStreamForThread` reports for a run waiting on a rate limit. */
export interface RateLimitPause {
    provider?: string;
    reason: "rate_limit";
    /** Epoch ms the run resumes at. */
    retryAt: number;
    status: number;
}

const TICK_MS = 1000;

/** The backend queues another resume for a pause this far past its retry time (`retryPausedRunsNow`): the first was lost. */
export const OVERDUE_MS = 30 * 1000;

/** Milliseconds until `retryAt`, re-read every second for as long as the notice is shown; negative once it has passed. */
const useRemainingMs = (retryAt: number): number => {
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        const timer = setInterval(() => {
            setNow(Date.now());
        }, TICK_MS);

        return () => {
            clearInterval(timer);
        };
    }, []);

    return retryAt - now;
};

interface RateLimitPauseNoticeViewProps {
    /** Whether the viewer may end the wait or stop the reply (write access to the thread). Everyone sees the countdown. */
    canControl: boolean;
    className?: string;
    isRetrying: boolean;
    isStopping: boolean;
    onRetryNow: () => void;
    onStop: () => void;
    pause: RateLimitPause;
}

export const RateLimitPauseNoticeView: FC<RateLimitPauseNoticeViewProps> = ({ canControl, className, isRetrying, isStopping, onRetryNow, onStop, pause }) => {
    const { t } = useLingui();
    const remainingMs = useRemainingMs(pause.retryAt);
    const provider = providerLabel(pause.provider);
    const isWaiting = remainingMs > 0;
    // The resume that was queued for the retry time did not run: asking again queues another.
    const isOverdue = remainingMs <= -OVERDUE_MS;
    const countdown = formatCountdown(remainingMs);
    const announced = formatCountdown(announcedWaitMs(remainingMs));

    let spoken: string;
    let shown: string;

    if (isOverdue) {
        spoken = t`The retry is taking longer than expected`;
        shown = spoken;
    } else if (!isWaiting) {
        spoken = t`Retrying now`;
        shown = spoken;
    } else if (provider) {
        spoken = t`Rate limited by ${provider}. Retrying in about ${announced}`;
        shown = t`Rate limited by ${provider}, retrying in ${countdown}`;
    } else {
        spoken = t`Rate limited. Retrying in about ${announced}`;
        shown = t`Rate limited, retrying in ${countdown}`;
    }

    return (
        <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)} data-rate-limit-pause="true">
            <span aria-live="polite" className="sr-only" role="status">
                {spoken}
            </span>
            <p aria-hidden="true" className="text-muted-foreground text-xs tabular-nums">
                {shown}
            </p>
            {canControl && (
                <div className="flex items-center gap-2">
                    <Button className="h-6 gap-1.5 text-xs" disabled={!(isWaiting || isOverdue) || isRetrying} onClick={onRetryNow} size="sm" variant="outline">
                        <RefreshCw aria-hidden="true" className="size-3" />
                        <Trans>Retry now</Trans>
                    </Button>
                    <Button className="h-6 gap-1.5 text-xs" disabled={isStopping} onClick={onStop} size="sm" variant="ghost">
                        <Square aria-hidden="true" className="size-3" />
                        <Trans>Stop</Trans>
                    </Button>
                </div>
            )}
        </div>
    );
};

interface RateLimitPauseNoticeProps {
    className?: string;
    pause: RateLimitPause;
    threadId: string;
}

/** The notice wired to the thread: "Retry now" ends the wait, "Stop" is the ordinary stop of the reply; both need write access. */
export const RateLimitPauseNotice: FC<RateLimitPauseNoticeProps> = ({ className, pause, threadId }) => {
    const crpc = useCRPC();
    const { t } = useLingui();
    const { isPending: isRetrying, mutate: retryNow } = useMutation(crpc.chat.rate_limit_retry.retryRateLimitedRun.mutationOptions());
    const { isPending: isStopping, mutate: stop } = useMutation(crpc.chat.functions.abortThreadStream.mutationOptions());
    // The viewer's own permission on the thread; unknown until it loads, and then the buttons stay away.
    const { data: access } = useQuery(crpc.chat.sharing.getThreadAccess.queryOptions(threadId ? { threadId: threadId as never } : skipToken));
    const canControl = access?.permission === "write" || access?.permission === "admin";

    return (
        <RateLimitPauseNoticeView
            canControl={canControl}
            className={className}
            isRetrying={isRetrying}
            isStopping={isStopping}
            onRetryNow={() => {
                retryNow({ threadId: threadId as never }, { onError: () => showError(t`Could not retry. Please try again.`) });
            }}
            onStop={() => {
                // Like the composer's Stop: a manual stop keeps the queued prompts, and nothing auto-sends them.
                usePromptQueueStore.getState().setPaused(threadId, true);
                stop({ threadId: threadId as never }, { onError: () => showError(t`Could not stop the reply. Please try again.`) });
            }}
            pause={pause}
        />
    );
};
