"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import clsx from "clsx";
import { Gauge } from "lucide-react";
import type { FC } from "react";

import type { ResearchDepth } from "@/features/chat/core/stores/model-store";

interface ComposerResearchDepthProps {
    depth: ResearchDepth;
    disabled?: boolean;
    onDepthChange: (depth: ResearchDepth) => void;
}

const DEPTH_ORDER: ResearchDepth[] = ["speed", "balanced", "thorough"];

/** The depth labels, shared by the control and the composer's status line. */
export const useResearchDepthLabels = (): Record<ResearchDepth, string> => {
    const { t } = useLingui();

    return {
        balanced: t`Balanced`,
        speed: t`Speed`,
        thorough: t`Thorough`,
    };
};

const ComposerResearchDepth: FC<ComposerResearchDepthProps> = ({ depth, disabled, onDepthChange }) => {
    const { t } = useLingui();

    const labels = useResearchDepthLabels();

    const descriptions: Record<ResearchDepth, string> = {
        balanced: t`Standard search depth`,
        speed: t`Quick lookup, fewer queries`,
        thorough: t`Deep research, many queries`,
    };

    const cycleDepth = () => {
        const currentIndex = DEPTH_ORDER.indexOf(depth);
        const nextIndex = (currentIndex + 1) % DEPTH_ORDER.length;

        onDepthChange(DEPTH_ORDER[nextIndex]!);
    };

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        aria-label={t`Search depth: ${labels[depth]}`}
                        className={clsx(
                            "bg-transparent hover:bg-surface-row-hover dark:hover:bg-surface-row-hover rounded-lg text-muted-foreground hover:text-foreground h-7 gap-1 px-2",
                            depth !== "balanced" && "bg-surface-row-active text-foreground",
                        )}
                        disabled={disabled}
                        onClick={cycleDepth}
                        variant="ghost"
                    >
                        <Gauge aria-hidden="true" className="size-3 shrink-0" />
                        <span className="@max-[40rem]/strip:sr-only">{labels[depth]}</span>
                    </Button>
                }
            />
            <TooltipContent side="top" sideOffset={8}>
                <p>{t`Search depth: ${labels[depth]}`}</p>
                <p className="text-muted-foreground text-xs">{descriptions[depth]}</p>
            </TooltipContent>
        </Tooltip>
    );
};

export default ComposerResearchDepth;
