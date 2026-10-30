"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleDashed, OctagonX, Target } from "lucide-react";
import type { FC } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { GoalVerdictView } from "./goal-view";
import type { ThreadGoalView } from "./use-thread-goal";

/** Why a goal ended without being met, in words. */
const useStopLabel = (): ((reason: NonNullable<ThreadGoalView["stopReason"]>) => string) => {
    const { t } = useLingui();

    return (reason) => {
        switch (reason) {
            case "cost_limit": {
                return t`Stopped: cost limit`;
            }
            case "daily_limit": {
                return t`Stopped: daily limit`;
            }
            case "review_failed": {
                return t`Stopped: the review could not run`;
            }
            case "round_limit": {
                return t`Stopped: round limit`;
            }
            case "superseded": {
                return t`Stopped: you sent a new message`;
            }
            case "unsupported": {
                return t`Stopped: goals are not available in group chats`;
            }
            case "user": {
                return t`Stopped by you`;
            }
            default: {
                return t`Stopped: the run failed`;
            }
        }
    };
};

/** The goal at the top of its run: the text, where it stands, and a stop while it works. */
export const GoalBanner: FC<{ goal: ThreadGoalView; maxWidth?: string; threadId: string }> = ({ goal, maxWidth, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const stopLabel = useStopLabel();
    const { isPending, mutate: stop } = useMutation(crpc.chat.functions.abortThreadStream.mutationOptions());
    const nextRound = Math.min(goal.round + 1, goal.maxRounds);

    let status: string;

    if (goal.status === "active") {
        status = t`Working toward the goal: round ${nextRound} of ${goal.maxRounds}`;
    } else if (goal.status === "met") {
        status = t`Goal met`;
    } else {
        status = goal.stopReason ? stopLabel(goal.stopReason) : t`Stopped`;
    }

    return (
        <section
            aria-label={t`Goal`}
            className="bg-muted/40 mx-auto my-3 flex w-full items-start gap-3 rounded-lg border px-3 py-2"
            data-goal-status={goal.status}
            style={{ maxWidth: maxWidth ?? "65ch" }}
        >
            <Target aria-hidden="true" className="text-primary mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1">
                <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t`Goal`}</p>
                <p className="text-sm break-words">{goal.text}</p>
                <p aria-live="polite" className="text-muted-foreground mt-1 text-xs" role="status">
                    {status}
                </p>
            </div>
            {goal.status === "active" && (
                <Button disabled={isPending} onClick={() => stop({ threadId: threadId as Id<"threads"> })} size="sm" variant="outline">
                    {t`Stop`}
                </Button>
            )}
        </section>
    );
};

/** A reviewer's verdict on one round, as a small note under the reply it judged. */
export const GoalVerdictNote: FC<{ goal: ThreadGoalView; maxWidth?: string; verdict: GoalVerdictView }> = ({ goal, maxWidth, verdict }) => {
    const { t } = useLingui();
    const stopLabel = useStopLabel();
    const isLast = verdict.round === goal.round;
    const ended = isLast && goal.status !== "active";
    let Icon = CircleDashed;

    if (verdict.met) {
        Icon = CheckCircle2;
    } else if (ended) {
        Icon = OctagonX;
    }

    return (
        <div
            className={cn("text-muted-foreground mx-auto my-2 flex w-full items-start gap-2 text-xs", verdict.met && "text-foreground")}
            data-goal-verdict={verdict.met ? "met" : "unmet"}
            role="status"
            style={{ maxWidth: maxWidth ?? "65ch" }}
        >
            <Icon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">
                {verdict.met ? t`Goal met: ${verdict.reason}` : t`Round ${verdict.round}: not yet. ${verdict.reason}`}
                {ended && !verdict.met && goal.stopReason ? ` ${stopLabel(goal.stopReason)}.` : ""}
            </p>
        </div>
    );
};

/** What a goal's reviewer found missing, shown where the instruction that carried it to the agent sits. */
export const GoalReviewNote: FC<{ maxWidth?: string; reason: string }> = ({ maxWidth, reason }) => {
    const { t } = useLingui();

    return (
        <div
            className="text-muted-foreground mx-auto my-2 flex w-full items-start gap-2 text-xs"
            data-goal-review="true"
            role="status"
            style={{ maxWidth: maxWidth ?? "65ch" }}
        >
            <CircleDashed aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
            <p className="min-w-0 break-words">{t`Review: ${reason}`}</p>
        </div>
    );
};
