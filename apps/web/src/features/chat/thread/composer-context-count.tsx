"use client";

import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useMemo } from "react";

import { formatTokenCount } from "@/components/model-picker/utilities";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import useModelInfo from "@/features/chat/core/hooks/use-model-info";
import useThreadUsage from "@/features/chat/core/hooks/use-thread-usage";

interface ComposerContextCountProps {
    className?: string;
}

/**
 * Displays context usage as a visual indicator in the composer.
 * Shows used tokens vs model's context window.
 */
const ComposerContextCount: FC<ComposerContextCountProps> = ({ className }) => {
    const { t } = useLingui();
    const { threadId } = useChatThread();
    const usage = useThreadUsage(threadId);
    const { contextWindow, modelDefinition } = useModelInfo(threadId);

    // Calculate usage percentage
    const { isAtCapacity, isCriticalUsage, isHighUsage, percentage, usedTokens } = useMemo(() => {
        const totalUsed = usage?.totalTokens ?? 0;
        const maxContext = contextWindow ?? 0;

        if (maxContext === 0) {
            return { isAtCapacity: false, isCriticalUsage: false, isHighUsage: false, percentage: 0, usedTokens: totalUsed };
        }

        const rawPct = (totalUsed / maxContext) * 100;
        const pct = Math.min(rawPct, 100);

        return {
            isAtCapacity: rawPct >= 100,
            isCriticalUsage: pct >= 90,
            isHighUsage: pct >= 70,
            percentage: pct,
            usedTokens: totalUsed,
        };
    }, [usage?.totalTokens, contextWindow]);

    // SVG circle parameters
    const size = 16;
    const strokeWidth = 2.5;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const offset = circumference - (percentage / 100) * circumference;

    // Color based on usage level
    const strokeColor = useMemo(() => {
        if (isCriticalUsage) {
            return "var(--destructive)";
        }

        if (isHighUsage) {
            return "var(--warning, #f59e0b)";
        }

        return "var(--primary)";
    }, [isHighUsage, isCriticalUsage]);

    // Don't render if no context window info available
    if (!contextWindow) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <div
                        className={cn(
                            "flex items-center gap-1.5 text-xs transition-colors",
                            isCriticalUsage && "text-destructive",
                            isHighUsage && !isCriticalUsage && "text-warning",
                            !isHighUsage && "text-muted-foreground",
                            className,
                        )}
                    >
                        {/* Circular progress indicator */}
                        <div className="flex size-4 items-center justify-center">
                            <svg className="-rotate-90 transform" height={size} width={size}>
                                <circle cx={size / 2} cy={size / 2} fill="none" r={radius} stroke="var(--muted)" strokeWidth={strokeWidth} />
                                {usedTokens > 0 && (
                                    <circle
                                        className="transition-[stroke-dashoffset,stroke] duration-300"
                                        cx={size / 2}
                                        cy={size / 2}
                                        fill="none"
                                        r={radius}
                                        stroke={strokeColor}
                                        strokeDasharray={circumference}
                                        strokeDashoffset={offset}
                                        strokeLinecap="round"
                                        strokeWidth={strokeWidth}
                                    />
                                )}
                            </svg>
                        </div>
                        {/* Token count text */}
                        <span className="tabular-nums">
                            {formatTokenCount(usedTokens)}/{formatTokenCount(contextWindow)}
                        </span>
                    </div>
                }
            />
            <TooltipContent align="end" side="top">
                <div className="space-y-1.5">
                    <div className="font-medium">{t`Context Usage`}</div>
                    <div className="text-muted-foreground text-xs">
                        {t`${formatTokenCount(usedTokens)} of ${formatTokenCount(contextWindow)} tokens used (${percentage.toFixed(1)}%)`}
                    </div>
                    {modelDefinition?.name && <div className="text-muted-foreground text-xs">{t`Model: ${modelDefinition.name}`}</div>}
                    {isAtCapacity && (
                        <div className="text-destructive text-xs font-medium">{t`Context window is full. Start a new conversation to continue.`}</div>
                    )}
                    {isCriticalUsage && !isAtCapacity && (
                        <div className="text-destructive text-xs font-medium">{t`Context nearly full. Consider starting a new conversation.`}</div>
                    )}
                    {isHighUsage && !isCriticalUsage && <div className="text-warning text-xs">{t`Context usage is high.`}</div>}
                </div>
            </TooltipContent>
        </Tooltip>
    );
};

export default ComposerContextCount;
