"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { useControllableState } from "@radix-ui/react-use-controllable-state";
import { Button } from "@ui/components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@ui/components/collapsible";
import useStreamdownPlugins from "@ui/hooks/use-streamdown-plugins";
import cn from "@ui/utils/cn";
import { BrainIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import type { ReasoningContextValue } from "./reasoning-context";
import { ReasoningContext } from "./reasoning-context";
import Shimmer from "./shimmer";
import { useReasoning } from "./use-reasoning";

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
    defaultOpen?: boolean;
    duration?: number;
    isStreaming?: boolean;
    onOpenChange?: (open: boolean) => void;
    open?: boolean;
};

const AUTO_CLOSE_DELAY = 1000;
const MS_IN_S = 1000;
const COPIED_FEEDBACK_MS = 2000;

/**
 * Moves focus to the trigger when focus is inside the block, before the block closes: a control in its content goes with it.
 * The block is the trigger's nearest `not-prose` ancestor, the root this component renders.
 */
const focusTriggerIfInside = (triggerId: string): void => {
    const trigger = document.querySelector<HTMLElement>(`[id="${CSS.escape(triggerId)}"]`);
    const block = trigger?.closest(".not-prose");

    if (trigger && block?.contains(document.activeElement)) {
        trigger.focus();
    }
};

export const Reasoning = memo(
    ({ children, className, defaultOpen = true, duration: durationProp, isStreaming = false, onOpenChange, open, ...props }: ReasoningProps) => {
        const [isOpen, setIsOpen] = useControllableState({
            defaultProp: defaultOpen,
            onChange: onOpenChange,
            prop: open,
        });
        const [duration, setDuration] = useControllableState({
            defaultProp: undefined,
            prop: durationProp,
        });

        const [hasAutoClosed, setHasAutoClosed] = useState(false);
        const triggerId = useId();
        // A ref, not state: the start timestamp is never rendered, it only feeds the
        // duration computed when streaming stops.
        const startTimeRef = useRef<number | null>(null);

        // Track duration when streaming starts and ends
        useEffect(() => {
            if (isStreaming) {
                startTimeRef.current ??= Date.now();
            } else if (startTimeRef.current !== null) {
                setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S));
                startTimeRef.current = null;
            }
        }, [isStreaming, setDuration]);

        // Auto-open when streaming starts, auto-close when streaming ends (once only)
        useEffect(() => {
            if (defaultOpen && !isStreaming && isOpen && !hasAutoClosed) {
                // Add a small delay before closing to allow user to see the content
                const timer = setTimeout(() => {
                    focusTriggerIfInside(triggerId);
                    setIsOpen(false);
                    setHasAutoClosed(true);
                }, AUTO_CLOSE_DELAY);

                return () => clearTimeout(timer);
            }

            return undefined;
        }, [isStreaming, isOpen, defaultOpen, setIsOpen, hasAutoClosed, triggerId]);

        const handleOpenChange = (newOpen: boolean) => {
            setIsOpen(newOpen);
        };

        const contextValue = useMemo<ReasoningContextValue>(() => {
            return { duration, isOpen, isStreaming, setIsOpen, triggerId };
        }, [duration, isOpen, isStreaming, setIsOpen, triggerId]);

        return (
            <ReasoningContext value={contextValue}>
                <Collapsible className={cn("not-prose mb-4", className)} onOpenChange={handleOpenChange} open={isOpen} {...props}>
                    {children}
                </Collapsible>
            </ReasoningContext>
        );
    },
);

export type ReasoningTriggerProps = ComponentProps<typeof CollapsibleTrigger> & {
    getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode;
};

const DefaultThinkingMessage = ({ duration, isStreaming }: { duration?: number; isStreaming: boolean }) => {
    const { t } = useLingui();

    if (isStreaming || duration === 0) {
        return <Shimmer duration={1}>{t`Thinking...`}</Shimmer>;
    }

    if (duration === undefined) {
        return <p>{t`Thought for a few seconds`}</p>;
    }

    return (
        <p>
            <Plural one="Thought for # second" other="Thought for # seconds" value={duration} />
        </p>
    );
};

const defaultGetThinkingMessage = (isStreaming: boolean, duration?: number) => <DefaultThinkingMessage duration={duration} isStreaming={isStreaming} />;

const getTriggerLabel = (isStreaming: boolean, isOpen: boolean): MessageDescriptor => {
    if (isStreaming) {
        return msg`Thinking in progress, collapse to hide`;
    }

    return isOpen ? msg`Collapse thinking` : msg`Expand thinking`;
};

export const ReasoningTrigger = memo(({ children, className, getThinkingMessage = defaultGetThinkingMessage, ...props }: ReasoningTriggerProps) => {
    const { i18n } = useLingui();
    const { duration, isOpen, isStreaming, triggerId } = useReasoning();

    return (
        <CollapsibleTrigger
            aria-label={i18n._(getTriggerLabel(isStreaming, isOpen))}
            className={cn("text-muted-foreground hover:text-foreground flex w-full items-center gap-2 text-sm transition-colors", className)}
            {...props}
            id={triggerId}
        >
            {children ?? (
                <>
                    <BrainIcon aria-hidden="true" className="size-4" />
                    <span aria-live="polite" role="status">
                        {getThinkingMessage(isStreaming, duration)}
                    </span>
                    <ChevronDownIcon aria-hidden="true" className={cn("size-4 transition-transform", isOpen ? "rotate-180" : "rotate-0")} />
                </>
            )}
        </CollapsibleTrigger>
    );
});

export type ReasoningContentProps = ComponentProps<typeof CollapsibleContent> & {
    children: string;
    /** Markdown components for the text, when it is not the model's own (a coding agent's reasoning loads no images). */
    components?: ComponentProps<typeof Streamdown>["components"];
};

export const ReasoningContent = memo(({ children, className, components, ...props }: ReasoningContentProps) => {
    const { t } = useLingui();
    const plugins = useStreamdownPlugins(children);
    const { isStreaming, setIsOpen, triggerId } = useReasoning();
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(setCopied, COPIED_FEEDBACK_MS, false);
        } catch {
            // The clipboard is refused outside a secure context or without permission; the text stays selectable.
        }
    };

    // The button below the text disappears with it, so keyboard focus goes back up to the trigger.
    const handleCollapse = () => {
        setIsOpen(false);
        document.querySelector<HTMLElement>(`[id="${CSS.escape(triggerId)}"]`)?.focus();
    };

    return (
        <CollapsibleContent
            className={cn(
                "mt-4 text-sm",
                "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-muted-foreground data-[state=closed]:animate-out data-[state=open]:animate-in outline-none",
                className,
            )}
            {...props}
        >
            <Streamdown {...(components && { components })} plugins={plugins}>
                {children}
            </Streamdown>
            {isStreaming ? null : (
                <div className="mt-2 flex items-center gap-1">
                    <Button onClick={handleCopy} size="sm" type="button" variant="ghost">
                        {copied ? <CheckIcon aria-hidden="true" /> : <CopyIcon aria-hidden="true" />}
                        {t`Copy reasoning`}
                    </Button>
                    <Button onClick={handleCollapse} size="sm" type="button" variant="ghost">
                        <ChevronUpIcon aria-hidden="true" />
                        {t`Collapse`}
                    </Button>
                    <span className="sr-only" role="status">
                        {copied ? t`Copied` : ""}
                    </span>
                </div>
            )}
        </CollapsibleContent>
    );
});

Reasoning.displayName = "Reasoning";
ReasoningTrigger.displayName = "ReasoningTrigger";
ReasoningContent.displayName = "ReasoningContent";
