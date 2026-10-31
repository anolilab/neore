"use client";

/**
 * Shown under a reply whose run is waiting out a provider's rate limit: who limited it, a live countdown, and the two
 * things a person can do — end the wait now, or stop the reply. The run resumes by itself at the retry time.
 *
 * Screen readers: the ticking `m:ss` is hidden from them (it would be read every second). A polite status region holds
 * the same sentence with the time rounded up to half a minute, so it speaks when the pause starts, every thirty seconds,
 * and once more when the wait is over.
 */

import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { RefreshCw, Square } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

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

/** Milliseconds left until `retryAt`, re-read every second for as long as the notice is shown. */
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

    return Math.max(0, retryAt - now);
};

interface RateLimitPauseNoticeViewProps {
    className?: string;
    isRetrying: boolean;
    isStopping: boolean;
    onRetryNow: () => void;
    onStop: () => void;
    pause: RateLimitPause;
}

export const RateLimitPauseNoticeView: FC<RateLimitPauseNoticeViewProps> = ({ className, isRetrying, isStopping, onRetryNow, onStop, pause }) => {
    const { t } = useLingui();
    const remainingMs = useRemainingMs(pause.retryAt);
    const provider = providerLabel(pause.provider);
    const isWaiting = remainingMs > 0;
    const countdown = formatCountdown(remainingMs);
    const announced = formatCountdown(announcedWaitMs(remainingMs));

    let spoken: string;
    let shown: string;

    if (!isWaiting) {
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
            <div className="flex items-center gap-2">
                <Button className="h-6 gap-1.5 text-xs" disabled={!isWaiting || isRetrying} onClick={onRetryNow} size="sm" variant="outline">
                    <RefreshCw aria-hidden="true" className="size-3" />
                    <Trans>Retry now</Trans>
                </Button>
                <Button className="h-6 gap-1.5 text-xs" disabled={isStopping} onClick={onStop} size="sm" variant="ghost">
                    <Square aria-hidden="true" className="size-3" />
                    <Trans>Stop</Trans>
                </Button>
            </div>
        </div>
    );
};

interface RateLimitPauseNoticeProps {
    className?: string;
    pause: RateLimitPause;
    threadId: string;
}

/** The notice wired to the thread: "Retry now" ends the wait, "Stop" is the ordinary stop of the reply. */
export const RateLimitPauseNotice: FC<RateLimitPauseNoticeProps> = ({ className, pause, threadId }) => {
    const crpc = useCRPC();
    const { t } = useLingui();
    const { isPending: isRetrying, mutate: retryNow } = useMutation(crpc.chat.rate_limit_retry.retryRateLimitedRun.mutationOptions());
    const { isPending: isStopping, mutate: stop } = useMutation(crpc.chat.functions.abortThreadStream.mutationOptions());

    return (
        <RateLimitPauseNoticeView
            className={className}
            isRetrying={isRetrying}
            isStopping={isStopping}
            onRetryNow={() => {
                retryNow({ threadId: threadId as never }, { onError: () => showError(t`Could not retry. Please try again.`) });
            }}
            onStop={() => {
                stop({ threadId: threadId as never }, { onError: () => showError(t`Could not stop the reply. Please try again.`) });
            }}
            pause={pause}
        />
    );
};
