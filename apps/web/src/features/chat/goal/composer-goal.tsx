"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Target } from "lucide-react";
import type { FC } from "react";

import { GOAL_ROUND_CHOICES, useGoalComposer } from "./goal-store";

interface ComposerGoalProps {
    disabled?: boolean;
}

/**
 * Makes the next message a goal. The agent keeps working, and after each turn a short review decides whether the goal is met;
 * if not, the review's reason is the next instruction. It stops when the goal is met or after the chosen number of review rounds.
 */
const ComposerGoal: FC<ComposerGoalProps> = ({ disabled }) => {
    const { t } = useLingui();
    const enabled = useGoalComposer((state) => state.enabled);
    const maxRounds = useGoalComposer((state) => state.maxRounds);
    const setEnabled = useGoalComposer((state) => state.setEnabled);
    const setMaxRounds = useGoalComposer((state) => state.setMaxRounds);

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
                            aria-label={enabled ? t`Turn off run until done` : t`Turn on run until done`}
                            aria-pressed={enabled}
                            className={clsx(
                                "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 text-foreground h-7 gap-1 px-2 dark:text-white",
                                enabled && "bg-primary/10 text-primary border-primary/30 dark:text-primary hover:bg-primary/20 hover:border-primary/40",
                            )}
                            disabled={disabled}
                            onClick={() => setEnabled(!enabled)}
                            variant="outline"
                        >
                            <Target aria-hidden="true" className="size-3 shrink-0" />
                            <span className="hidden sm:inline">{t`Goal`}</span>
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
                            <Button
                                aria-label={t`Review rounds: ${maxRounds}. Change`}
                                className="bg-primary/10 text-primary border-primary/30 h-7 px-2"
                                disabled={disabled}
                                onClick={cycleRounds}
                                variant="outline"
                            >
                                {t`${maxRounds} rounds`}
                            </Button>
                        }
                    />
                    <TooltipContent side="top" sideOffset={8}>
                        <p>{t`The most review rounds before it stops`}</p>
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    );
};

export default ComposerGoal;
