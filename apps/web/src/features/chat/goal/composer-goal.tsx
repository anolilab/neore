"use client";

import { useLingui } from "@lingui/react/macro";
import { isCustomModelId } from "@neore/ai/models";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { Target } from "lucide-react";
import type { FC } from "react";
import { useEffect } from "react";

import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { findLocalModelTarget } from "@/features/settings/lib/custom-models";
import { useCRPC } from "@/lib/lunora/crpc";

import { GOAL_ROUND_CHOICES, useGoalComposer } from "./goal-store";
import PinnedGoal from "./pinned-goal";

interface ComposerGoalProps {
    disabled?: boolean;
    /** The chat the pin belongs to. Unset for a chat not yet created, which cannot be pinned. */
    threadId?: string;
}

/**
 * Makes the next message a goal. The agent keeps working, and after each turn a short review decides whether the goal is met;
 * if not, the review's reason is the next instruction. It stops when the goal is met or after the chosen number of review rounds.
 */
const ComposerGoal: FC<ComposerGoalProps> = ({ disabled, threadId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const currentModel: string = useCurrentModel();
    // A local model runs in the browser and never reaches the goal loop, so the control is not offered there.
    const { data: providers } = useQuery(crpc.chat.custom_providers.listCustomProviders.queryOptions(isCustomModelId(currentModel) ? {} : skipToken));
    const isLocalModel = findLocalModelTarget(providers, currentModel) !== undefined;
    const enabled = useGoalComposer((state) => state.enabled);
    const maxRounds = useGoalComposer((state) => state.maxRounds);
    const setEnabled = useGoalComposer((state) => state.setEnabled);
    const setMaxRounds = useGoalComposer((state) => state.setMaxRounds);

    // A goal armed before switching to a local model must not wait for the next gateway send.
    useEffect(() => {
        if (isLocalModel) {
            setEnabled(false);
        }
    }, [isLocalModel, setEnabled]);

    if (isLocalModel) {
        return null;
    }

    const cycleRounds = () => {
        const index = GOAL_ROUND_CHOICES.indexOf(maxRounds as (typeof GOAL_ROUND_CHOICES)[number]);

        setMaxRounds(GOAL_ROUND_CHOICES[(index + 1) % GOAL_ROUND_CHOICES.length]!);
    };

    return (
        <div className="flex items-center gap-1">
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button
                            // The name starts with the visible label ("Goal"), so a voice user hears what a sighted user sees.
                            aria-label={t`Goal: run until done`}
                            aria-pressed={enabled}
                            className={clsx(
                                "bg-transparent hover:bg-surface-row-hover dark:hover:bg-surface-row-hover rounded-lg text-muted-foreground hover:text-foreground h-7 gap-1 px-2",
                                enabled && "bg-surface-row-active text-foreground",
                            )}
                            disabled={disabled}
                            onClick={() => setEnabled(!enabled)}
                            variant="ghost"
                        >
                            <Target aria-hidden="true" className="size-3 shrink-0" />
                            <span className="@max-[32rem]/strip:sr-only">{t`Goal`}</span>
                        </Button>
                    }
                />
                <TooltipContent side="top" sideOffset={8}>
                    <p>{t`Run until done`}</p>
                    <p className="text-muted-foreground text-xs">{t`Your next message is a goal. The agent keeps working until a review confirms it is met.`}</p>
                </TooltipContent>
            </Tooltip>
            {enabled && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button className="bg-surface-row-active text-foreground h-7 px-2" disabled={disabled} onClick={cycleRounds} variant="ghost">
                                {t`${maxRounds} rounds`}
                            </Button>
                        }
                    />
                    <TooltipContent side="top" sideOffset={8}>
                        <p>{t`The most review rounds before it stops`}</p>
                    </TooltipContent>
                </Tooltip>
            )}
            {threadId !== undefined && <PinnedGoal disabled={disabled} threadId={threadId} />}
        </div>
    );
};

export default ComposerGoal;
