"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@ui/components/tooltip";
import cn from "@ui/utils/cn";
import { formatTime } from "@ui/utils/locale-format";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { createContext, use, useCallback, useMemo, useState } from "react";

export interface WebPreviewContextValue {
    consoleOpen: boolean;
    setConsoleOpen: (open: boolean) => void;
    setUrl: (url: string) => void;
    url: string;
}

const WebPreviewContext = createContext<WebPreviewContextValue | null>(null);

const useWebPreview = () => {
    const context = use(WebPreviewContext);

    if (!context) {
        throw new Error("WebPreview components must be used within a WebPreview");
    }

    return context;
};

export type WebPreviewProps = ComponentProps<"div"> & {
    defaultUrl?: string;
    onUrlChange?: (url: string) => void;
};

export const WebPreview = ({ children, className, defaultUrl = "", onUrlChange, ...props }: WebPreviewProps) => {
    const [url, setUrl] = useState(defaultUrl);
    const [consoleOpen, setConsoleOpen] = useState(false);

    const handleUrlChange = useCallback(
        (newUrl: string) => {
            setUrl(newUrl);
            onUrlChange?.(newUrl);
        },
        [onUrlChange],
    );

    const contextValue = useMemo<WebPreviewContextValue>(() => {
        return {
            consoleOpen,
            setConsoleOpen,
            setUrl: handleUrlChange,
            url,
        };
    }, [consoleOpen, handleUrlChange, url]);

    return (
        <WebPreviewContext value={contextValue}>
            <div className={cn("bg-card flex size-full flex-col rounded-lg border", className)} {...props}>
                {children}
            </div>
        </WebPreviewContext>
    );
};

export type WebPreviewNavigationProps = ComponentProps<"div">;

export const WebPreviewNavigation = ({ children, className, ...props }: WebPreviewNavigationProps) => (
    <div className={cn("flex items-center gap-1 border-b p-2", className)} {...props}>
        {children}
    </div>
);

export type WebPreviewNavigationButtonProps = ComponentProps<typeof Button> & {
    tooltip?: string;
};

export const WebPreviewNavigationButton = ({ children, disabled, onClick, tooltip, ...props }: WebPreviewNavigationButtonProps) => (
    <TooltipProvider>
        <Tooltip>
            <TooltipTrigger
                render={<Button className="hover:text-foreground h-8 w-8 p-0" disabled={disabled} onClick={onClick} size="sm" variant="ghost" {...props} />}
            >
                {children}
            </TooltipTrigger>
            <TooltipContent>
                <p>{tooltip}</p>
            </TooltipContent>
        </Tooltip>
    </TooltipProvider>
);

export type WebPreviewUrlProps = ComponentProps<typeof Input>;

export const WebPreviewUrl = ({ onChange, onKeyDown, value, ...props }: WebPreviewUrlProps) => {
    const { t } = useLingui();
    const { setUrl, url } = useWebPreview();
    const [inputValue, setInputValue] = useState(url);
    const [previousUrl, setPreviousUrl] = useState(url);

    // Sync input value with context URL when it changes externally. Done during
    // render rather than in an effect — React re-runs this component before
    // committing, so the input never paints the stale URL.
    if (url !== previousUrl) {
        setPreviousUrl(url);
        setInputValue(url);
    }

    const handleChange: NonNullable<WebPreviewUrlProps["onChange"]> = (event) => {
        setInputValue(event.target.value);
        onChange?.(event);
    };

    const handleKeyDown: NonNullable<WebPreviewUrlProps["onKeyDown"]> = (event) => {
        if (event.key === "Enter") {
            const target = event.target as HTMLInputElement;

            setUrl(target.value);
        }

        onKeyDown?.(event);
    };

    return (
        <Input
            className="h-8 flex-1 text-sm"
            onChange={onChange ?? handleChange}
            onKeyDown={handleKeyDown}
            placeholder={t`Enter URL...`}
            value={value ?? inputValue}
            {...props}
        />
    );
};

export type WebPreviewBodyProps = ComponentProps<"iframe"> & {
    loading?: ReactNode;
};

export const WebPreviewBody = ({ className, loading, src, ...props }: WebPreviewBodyProps) => {
    const { t } = useLingui();
    const { url } = useWebPreview();

    return (
        <div className="flex-1">
            <iframe
                className={cn("size-full", className)}
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
                src={(src ?? url) || undefined}
                title={t`Preview`}
                {...props}
            />
            {loading}
        </div>
    );
};

export type WebPreviewConsoleProps = ComponentProps<"div"> & {
    logs?: {
        level: "log" | "warn" | "error";
        message: string;
        timestamp: Date;
    }[];
};

const EMPTY_LOGS: NonNullable<WebPreviewConsoleProps["logs"]> = [];

export const WebPreviewConsole = ({ children, className, logs = EMPTY_LOGS, ...props }: WebPreviewConsoleProps) => {
    const { i18n, t } = useLingui();
    const { consoleOpen, setConsoleOpen } = useWebPreview();

    return (
        <Collapsible className={cn("bg-muted/50 border-t font-mono text-sm", className)} onOpenChange={setConsoleOpen} open={consoleOpen} {...props}>
            <CollapsibleTrigger
                render={<Button className="hover:bg-muted/50 flex w-full items-center justify-between p-4 text-left font-medium" variant="ghost" />}
            >
                {t`Console`}
                <ChevronDownIcon aria-hidden="true" className={cn("h-4 w-4 transition-transform duration-200", consoleOpen && "rotate-180")} />
            </CollapsibleTrigger>
            <CollapsibleContent
                className={cn(
                    "px-4 pb-4",
                    "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
                )}
            >
                <div className="max-h-48 space-y-1 overflow-y-auto">
                    {logs.length === 0 ? (
                        <p className="text-muted-foreground">{t`No console output`}</p>
                    ) : (
                        logs.map((log, index) => (
                            <div
                                className={cn(
                                    "text-xs",
                                    log.level === "error" && "text-destructive",
                                    log.level === "warn" && "text-yellow-600",
                                    log.level === "log" && "text-foreground",
                                )}
                                key={`${log.timestamp.getTime()}-${index}`}
                            >
                                <span className="text-muted-foreground">{formatTime(log.timestamp, i18n.locale)}</span> {log.message}
                            </div>
                        ))
                    )}
                    {children}
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
};
