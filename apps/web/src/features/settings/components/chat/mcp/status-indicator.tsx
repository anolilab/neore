import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { FC } from "react";

import type { ServerStatusInfo } from "./types";

/** Colored status dot + label. */
export const StatusIndicator: FC<{ info: ServerStatusInfo }> = ({ info }) => {
    const { t } = useLingui();

    switch (info.status) {
        case "connected": {
            return (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <span className="inline-flex items-center gap-1.5">
                                    <span className="relative flex size-2">
                                        <span className="absolute inline-flex size-full animate-ping rounded-full bg-green-400 opacity-75" />
                                        <span className="relative inline-flex size-2 rounded-full bg-green-500" />
                                    </span>
                                    <span className="text-[10px] text-green-600 dark:text-green-400">{t`Connected`}</span>
                                </span>
                            }
                        />
                        <TooltipContent side="top">
                            <p className="text-xs">
                                {t`${info.tools.length} tools discovered`}
                                {info.latencyMs != null && ` ${t`in ${info.latencyMs}ms`}`}
                            </p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            );
        }

        case "connecting": {
            return (
                <span className="inline-flex items-center gap-1.5">
                    <Loader2 className="size-3 animate-spin text-amber-500" />
                    <span className="text-[10px] text-amber-500">{t`Checking...`}</span>
                </span>
            );
        }

        case "error": {
            return (
                <TooltipProvider>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <span className="inline-flex items-center gap-1.5">
                                    <AlertTriangle className="size-3 text-red-500" />
                                    <span className="text-[10px] text-red-500">{t`Error`}</span>
                                </span>
                            }
                        />
                        <TooltipContent className="max-w-[280px]" side="top">
                            <p className="text-xs break-words">{info.error || t`Connection failed`}</p>
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            );
        }

        default: {
            return null;
        }
    }
};

/** Tool preview chips: show first 3 tools + "+N more". */
export const ToolChips: FC<{ tools: string[] }> = ({ tools }) => {
    const { t } = useLingui();

    if (tools.length === 0) {
        return null;
    }

    const remaining = tools.length - 3;

    return (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
            {tools.slice(0, 3).map((tool) => (
                <span className="bg-secondary text-secondary-foreground inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium" key={tool}>
                    {tool}
                </span>
            ))}
            {tools.length > 3 && (
                <span className="bg-muted text-muted-foreground inline-flex items-center rounded-full px-2 py-0.5 text-[10px]">{t`+${remaining} more`}</span>
            )}
        </div>
    );
};
