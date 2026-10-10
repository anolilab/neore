"use client";

import { useLingui } from "@lingui/react/macro";
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@neore/ui/components/dropdown-menu";
import { Separator } from "@neore/ui/components/separator";
import cn from "@neore/ui/utils/cn";
import { ChevronDown, Sparkles } from "lucide-react";
import type { FC } from "react";
import { useShallow } from "zustand/react/shallow";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { useChatIsStreaming } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import useOptimizerStyleLabels from "@/features/chat/prompt-improvement/hooks/use-optimizer-style-labels";
import type { UserOptimizerStyle } from "@/features/chat/prompt-improvement/lib/optimizer-client";
import usePromptImprovementStore from "@/features/chat/prompt-improvement/stores/prompt-improvement-store";

interface ComposerPromptImprovementButtonProps {
    threadId?: string;
}

const STYLE_OPTIONS: UserOptimizerStyle[] = ["basic", "professional", "planning"];

const ComposerPromptImprovementButton: FC<ComposerPromptImprovementButtonProps> = ({ threadId }) => {
    const { t } = useLingui();
    const styleLabels = useOptimizerStyleLabels();

    // A boolean, so typing does not re-render the button on every keystroke.
    const hasComposerText = useChatUIStore((state) => state.composerText.trim().length > 0);

    const { sseStreamState } = useChatIsStreaming();
    const isSSEStreaming = !!sseStreamState;

    const { dismiss, isImproving, isOpen, open, setStyle, style } = usePromptImprovementStore(
        useShallow((state) => {
            return {
                dismiss: state.dismiss,
                isImproving: state.isImproving,
                isOpen: state.isOpen,
                open: state.open,
                setStyle: state.setStyle,
                style: state.style,
            };
        }),
    );

    if (!hasComposerText || isSSEStreaming) {
        return null;
    }

    const handleClick = () => {
        if (isOpen) {
            dismiss();

            return;
        }

        // Read at click time: the button subscribes to "has text", not to the text.
        const { composerText } = useChatUIStore.getState();

        if (composerText) {
            // Pass the real thread id when we have one; otherwise leave it
            // undefined so the backend creates a temporary thread. Passing the
            // sentinel "new" used to be required when the action expected a
            // string — the action now accepts `threadId?: string`.
            open(composerText, threadId);
        }
    };

    const getTooltip = () => {
        if (isImproving) {
            return t`Improving prompt...`;
        }

        if (isOpen) {
            return t`Close prompt improvement`;
        }

        return t`Improve prompt with AI (${styleLabels.user[style].label})`;
    };

    return (
        <>
            <div className="flex self-stretch py-4">
                <Separator className="h-full" orientation="vertical" />
            </div>
            <div className="flex items-center">
                <TooltipIconButton
                    className={cn("mx-0 my-4 p-2 transition-opacity ease-in dark:text-neutral-100", isOpen && "bg-accent text-accent-foreground")}
                    disabled={isImproving}
                    onClick={handleClick}
                    tooltip={getTooltip()}
                    type="button"
                    variant="ghost"
                >
                    <Sparkles className={cn("h-4 w-4", isImproving && "animate-pulse")} />
                </TooltipIconButton>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        aria-label={t`Choose prompt improvement style`}
                        className="text-muted-foreground hover:text-foreground hover:bg-accent focus-visible:ring-ring my-4 -ml-1 flex items-center rounded p-1 text-[10px] focus-visible:ring-1 focus-visible:outline-none"
                        disabled={isImproving}
                        type="button"
                    >
                        <ChevronDown aria-hidden="true" className="h-3 w-3" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-72">
                        <DropdownMenuLabel>{t`Optimization style`}</DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        {STYLE_OPTIONS.map((option) => (
                            <DropdownMenuCheckboxItem
                                checked={style === option}
                                key={option}
                                onCheckedChange={(checked) => {
                                    if (checked) {
                                        setStyle(option);
                                    }
                                }}
                            >
                                <div className="flex flex-col">
                                    <span>{styleLabels.user[option].label}</span>
                                    <span className="text-muted-foreground text-xs">{styleLabels.user[option].description}</span>
                                </div>
                            </DropdownMenuCheckboxItem>
                        ))}
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            <div className="mr-1 flex py-2">
                <Separator className="h-6" orientation="vertical" />
            </div>
        </>
    );
};

export default ComposerPromptImprovementButton;
