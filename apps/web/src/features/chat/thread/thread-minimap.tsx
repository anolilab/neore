"use client";

/**
 * Outline rail beside the message list: one button per user prompt in the active
 * branch. Clicking one goes through `scrollToMessage`, so a prompt in the
 * virtualized head or not loaded yet is still reached by the list's own jump logic.
 */

import { useLingui } from "@lingui/react/macro";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";
import { useMemo } from "react";

import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";

import { scrollToMessage } from "./message-list";
import { buildMinimapItems, shouldShowMinimap } from "./minimap-items";

interface ThreadMinimapProps {
    className?: string;
}

const ThreadMinimap: FC<ThreadMinimapProps> = ({ className }) => {
    const { t } = useLingui();
    const { messages } = useChatMessages();
    const { threadId } = useChatThread();

    const items = useMemo(() => buildMinimapItems(messages), [messages]);

    if (!shouldShowMinimap(items)) {
        return null;
    }

    return (
        // not-prose: the rail sits inside the `prose` message column, whose list typography would otherwise apply.
        <nav aria-label={t`Prompts in this conversation`} className={cn("not-prose max-h-[60vh] w-6 shrink-0 overflow-y-auto", className)}>
            <TooltipProvider>
                <ol className="m-0 flex list-none flex-col items-center gap-1 py-1">
                    {items.map((item, index) => {
                        const promptNumber = index + 1;
                        const preview = item.preview || t`Attachment only`;

                        return (
                            <li key={item.id}>
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <button
                                                aria-label={t`Jump to prompt ${promptNumber}: ${preview}`}
                                                className="group focus-visible:ring-ring flex h-4 w-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                                                onClick={() => scrollToMessage(item.id, { threadId })}
                                                type="button"
                                            >
                                                <span
                                                    aria-hidden="true"
                                                    className="bg-muted-foreground/40 group-hover:bg-foreground h-0.5 w-4 rounded-full motion-safe:transition-colors"
                                                />
                                            </button>
                                        }
                                    />
                                    <TooltipContent className="max-w-xs" side="left">
                                        <p className="break-words">{preview}</p>
                                    </TooltipContent>
                                </Tooltip>
                            </li>
                        );
                    })}
                </ol>
            </TooltipProvider>
        </nav>
    );
};

export default ThreadMinimap;
