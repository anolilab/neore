"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import { Calculator } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

export interface WolframData {
    pods: {
        isPrimary: boolean;
        text: string;
        title: string;
    }[];
    query: string;
    shortAnswer?: string;
    success: boolean;
    suggestion?: string;
}

interface WolframWidgetProps {
    output: WolframData;
}

const MAX_PODS = 3;

const WolframWidget: FC<WolframWidgetProps> = ({ output }) => {
    const [expanded, setExpanded] = useState(false);
    const { t } = useLingui();
    const { suggestion } = output;

    if (!output.success || (!output.shortAnswer && output.pods.length === 0)) {
        return (
            <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-red-50 p-4 dark:bg-red-950/20">
                <p className="text-sm text-red-600 dark:text-red-400">{suggestion ? t`Did you mean: ${suggestion}?` : t`No results found.`}</p>
            </div>
        );
    }

    const primaryPod = output.pods.find((p) => p.isPrimary);
    const otherPods = output.pods.filter((p) => !p.isPrimary);
    const visiblePods = expanded ? otherPods : otherPods.slice(0, MAX_PODS);
    const hasMore = otherPods.length > MAX_PODS;

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-gradient-to-br from-orange-50/50 to-amber-50/50 dark:from-orange-950/10 dark:to-amber-950/10">
            {/* Header */}
            <div className="flex items-center gap-2 p-3 pb-2">
                <Calculator aria-hidden="true" className="size-4 text-orange-600 dark:text-orange-400" />
                <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">{output.query}</span>
            </div>

            {/* Short answer / Primary result */}
            {(output.shortAnswer || primaryPod) && (
                <div className="px-3 pb-3">
                    <div className="text-lg leading-snug font-bold whitespace-pre-wrap">{output.shortAnswer || primaryPod?.text}</div>
                    {primaryPod && output.shortAnswer && primaryPod.text !== output.shortAnswer && (
                        <div className="text-muted-foreground mt-1 text-xs">{primaryPod.title}</div>
                    )}
                </div>
            )}

            {/* Additional pods */}
            {visiblePods.length > 0 && (
                <div className="divide-y border-t">
                    {visiblePods.map((pod) => (
                        <div className="px-3 py-2" key={pod.title}>
                            <div className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">{pod.title}</div>
                            <div className="mt-0.5 text-xs whitespace-pre-wrap">{pod.text}</div>
                        </div>
                    ))}
                </div>
            )}

            {/* Show more */}
            {hasMore && !expanded && (
                <button
                    className="text-muted-foreground hover:text-foreground w-full border-t px-3 py-2 text-center text-xs transition-colors"
                    onClick={() => setExpanded(true)}
                    type="button"
                >
                    <Plural one="Show # more result" other="Show # more results" value={otherPods.length - MAX_PODS} />
                </button>
            )}
        </div>
    );
};

export default WolframWidget;
