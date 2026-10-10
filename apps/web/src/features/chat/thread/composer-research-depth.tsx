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

const ComposerResearchDepth: FC<ComposerResearchDepthProps> = ({ depth, disabled, onDepthChange }) => {
    const { t } = useLingui();

    const labels: Record<ResearchDepth, string> = {
        balanced: t`Balanced`,
        speed: t`Speed`,
        thorough: t`Thorough`,
    };

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
                            "bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 hover:border-border dark:hover:border-sidebar-border/50 text-foreground h-7 gap-1 px-2 dark:text-white",
                            depth !== "balanced" &&
                                "bg-primary/10 text-primary border-primary/30 dark:text-primary hover:bg-primary/20 hover:border-primary/40",
                        )}
                        disabled={disabled}
                        onClick={cycleDepth}
                        variant="outline"
                    >
                        <Gauge aria-hidden="true" className="size-3 shrink-0" />
                        <span className="hidden sm:inline">{labels[depth]}</span>
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
