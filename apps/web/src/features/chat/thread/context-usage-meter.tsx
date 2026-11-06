"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useMemo } from "react";

import { formatTokenCount } from "@/components/model-picker/utilities";

interface ContextUsageMeterProps {
    className?: string;
    /** The context window in tokens. A meter is drawn only for a window that is known. */
    contextWindow: number;
    /** A line under the usage: the model's name, or what the agent reported as its cost. */
    detail?: string;
    usedTokens: number;
}

/**
 * The context ring and its tooltip, with no source of its own: the cloud composer feeds it the thread's usage and the
 * model's window, a host thread the figures its agent reported (`agentState.usage`).
 */
/** A percentage with one decimal, in the locale's number format. A call, not a name, in the tooltip keeps its message id. */
const formatPercent = (value: number, locale: string): string =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format(value);

const ContextUsageMeter: FC<ContextUsageMeterProps> = ({ className, contextWindow, detail, usedTokens }) => {
    const { i18n, t } = useLingui();

    const { isAtCapacity, isCriticalUsage, isHighUsage, percentage } = useMemo(() => {
        const rawPct = contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0;
        const pct = Math.min(rawPct, 100);

        return {
            isAtCapacity: rawPct >= 100,
            isCriticalUsage: pct >= 90,
            isHighUsage: pct >= 70,
            percentage: pct,
        };
    }, [usedTokens, contextWindow]);

    // The percentage in the person's number format: a comma in German, not the period `toFixed` always writes.
    const percent = formatPercent(percentage, i18n.locale);

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

    // Nothing is drawn for a window that is not known: a ring against zero tokens of no window says nothing.
    if (contextWindow <= 0) {
        return null;
    }

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <button
                        aria-label={t`${formatTokenCount(usedTokens, i18n.locale)}/${formatTokenCount(contextWindow, i18n.locale)} ${plural(usedTokens, { one: "token used", other: "tokens used" })} (${percent}%)`}
                        className={cn(
                            "flex items-center gap-1.5 text-xs transition-colors",
                            isCriticalUsage && "text-destructive",
                            isHighUsage && !isCriticalUsage && "text-warning",
                            !isHighUsage && "text-muted-foreground",
                            className,
                        )}
                        type="button"
                    >
                        {/* Circular progress indicator */}
                        <div className="flex size-4 items-center justify-center">
                            <svg aria-hidden="true" className="-rotate-90 transform" height={size} width={size}>
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
                            {formatTokenCount(usedTokens, i18n.locale)}/{formatTokenCount(contextWindow, i18n.locale)}
                        </span>
                    </button>
                }
            />
            <TooltipContent align="end" side="top">
                <div className="space-y-1.5">
                    <div className="font-medium">{t`Context Usage`}</div>
                    <div className="text-muted-foreground text-xs">
                        {t`${formatTokenCount(usedTokens, i18n.locale)} of ${formatTokenCount(contextWindow, i18n.locale)} ${plural(usedTokens, { one: "token used", other: "tokens used" })} (${formatPercent(percentage, i18n.locale)}%)`}
                    </div>
                    {detail !== undefined && <div className="text-muted-foreground text-xs">{detail}</div>}
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

export default ContextUsageMeter;
