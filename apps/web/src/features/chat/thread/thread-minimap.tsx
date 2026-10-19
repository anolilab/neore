"use client";

/**
 * Outline rail beside the message list: one button per user prompt in the active
 * branch. Clicking one goes through `scrollToMessage`, so a prompt in the
 * virtualized head or not loaded yet is still reached by the list's own jump logic.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useMemo, useRef } from "react";

import { useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import useAfterFirstPaint from "@/hooks/use-after-first-paint";
import { useCRPC } from "@/lib/lunora/crpc";

import { scrollToMessage } from "./message-list";
import { buildMinimapItems, mergeOutline, promptsDropped, shouldShowMinimap } from "./minimap-items";

/** The outline is cheap to keep: it changes only when the active path does, which the effect below watches. */
const OUTLINE_STALE_MS = 5 * 60_000;

interface ThreadMinimapProps {
    className?: string;
}

const ThreadMinimap: FC<ThreadMinimapProps> = ({ className }) => {
    const { t } = useLingui();
    const { messages, messagesStatus } = useChatMessages();
    const { threadId } = useChatThread();
    const crpc = useCRPC();

    // Only a chat with older pages still to load needs the server outline; a fully loaded one already has every prompt.
    // One read per chat (not live: a live query would re-run on every streamed write), after first paint so it does not
    // join the first-paint burst, and kept for minutes so a window refocus does not scan the chat again.
    const afterFirstPaint = useAfterFirstPaint();
    const hasUnloadedHistory = messagesStatus === "CanLoadMore" || messagesStatus === "LoadingMore";
    const outlineOptions = crpc.chat.prompt_outline.getThreadPromptOutline.queryOptions(
        afterFirstPaint && hasUnloadedHistory && threadId ? { threadId: threadId as Id<"threads"> } : skipToken,
        { live: false },
    );
    const { data: outline } = useQuery({ ...outlineOptions, staleTime: OUTLINE_STALE_MS });

    const loadedItems = useMemo(() => buildMinimapItems(messages), [messages]);
    const items = useMemo(() => mergeOutline(outline?.items, loadedItems), [outline, loadedItems]);

    // The outline is read once, so a branch switch, an edit or a delete (a loaded prompt that is no longer there)
    // leaves it listing prompts that are off the active path. Read it again then.
    const queryClient = useQueryClient();
    const previousPrompts = useRef<{ ids: ReadonlySet<string>; threadId: string | undefined }>({ ids: new Set(), threadId: undefined });

    useEffect(() => {
        const ids = new Set(loadedItems.map((item) => item.id));
        const previous = previousPrompts.current;

        previousPrompts.current = { ids, threadId };

        if (previous.threadId === threadId && promptsDropped(previous.ids, ids)) {
            queryClient.invalidateQueries({ queryKey: outlineOptions.queryKey });
        }
    }, [loadedItems, threadId, queryClient, outlineOptions.queryKey]);

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
