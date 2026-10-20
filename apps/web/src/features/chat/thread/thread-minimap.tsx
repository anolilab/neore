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

import formatMessageTime from "./format-message-time";
import { scrollToMessage } from "./message-list";
import { useActivePromptId } from "./minimap-active";
import { buildMinimapItems, isProvisionalId, mergeOutline, minimapGapLabel, promptsDropped, shouldShowMinimap } from "./minimap-items";

/** The outline is cheap to keep: it changes only when the active path does, which the effect below watches. */
const OUTLINE_STALE_MS = 5 * 60_000;

interface ThreadMinimapProps {
    className?: string;
}

const ThreadMinimap: FC<ThreadMinimapProps> = ({ className }) => {
    const { i18n, t } = useLingui();
    const { isStreaming, messages, messagesStatus } = useChatMessages();
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
    // Refetched on mount: a reopened chat may have changed while it was closed, and the stale time would hide that.
    const { data: outline } = useQuery({ ...outlineOptions, refetchOnMount: "always", staleTime: OUTLINE_STALE_MS });

    const loadedItems = useMemo(() => buildMinimapItems(messages), [messages]);
    const items = useMemo(() => mergeOutline(outline?.items, loadedItems), [outline, loadedItems]);
    // The prompt being read: its tick turns white, so the rail shows where the reader is.
    const activeId = useActivePromptId(useMemo(() => items.map((item) => item.id), [items]));

    // The outline is read once, so a branch switch, an edit or a delete (a loaded prompt that is no longer there)
    // leaves it listing prompts that are off the active path. Read it again then.
    // The key is built from the thread, not from `outlineOptions`: that one is the skipped key while the outline is not read.
    const queryClient = useQueryClient();
    // The thread the flag is for: a re-read after a stream belongs to that chat's outline, not whichever one is open then.
    const reReadWhenIdle = useRef<string | undefined>(undefined);
    const previousPrompts = useRef<{ ids: ReadonlySet<string>; threadId: string | undefined }>({ ids: new Set(), threadId: undefined });

    useEffect(() => {
        // A sent prompt's optimistic id is replaced by its stored id; that is not a prompt that went away.
        const ids = new Set(loadedItems.filter((item) => !isProvisionalId(item.id)).map((item) => item.id));
        const previous = previousPrompts.current;

        previousPrompts.current = { ids, threadId };

        if (previous.threadId === threadId && promptsDropped(previous.ids, ids)) {
            // A regenerate hides prompts before the server moves the path, so a read made while streaming can be stale:
            // read again once streaming settles. Outside a stream the immediate read is already the current path.
            if (isStreaming) {
                reReadWhenIdle.current = threadId;
            }

            queryClient.invalidateQueries({ queryKey: crpc.chat.prompt_outline.getThreadPromptOutline.queryKey({ threadId: threadId as Id<"threads"> }) });
        }
    }, [loadedItems, threadId, isStreaming, queryClient, crpc]);

    useEffect(() => {
        const pendingThreadId = reReadWhenIdle.current;

        if (isStreaming || pendingThreadId === undefined) {
            return;
        }

        reReadWhenIdle.current = undefined;

        if (pendingThreadId !== threadId) {
            return;
        }

        queryClient.invalidateQueries({ queryKey: crpc.chat.prompt_outline.getThreadPromptOutline.queryKey({ threadId: threadId as Id<"threads"> }) });
    }, [isStreaming, threadId, queryClient, crpc]);

    if (!shouldShowMinimap(items)) {
        return null;
    }

    return (
        // not-prose: the rail sits inside the `prose` message column, whose list typography would otherwise apply.
        <nav aria-label={t`Prompts in this conversation`} className={cn("not-prose max-h-[60vh] w-9 shrink-0 overflow-y-auto", className)}>
            <TooltipProvider>
                <ol className="m-0 flex list-none flex-col items-center gap-1 py-1">
                    {items.map((item, index) => {
                        const promptNumber = index + 1;
                        const preview = item.preview || t`Attachment only`;
                        // Labels the time since the previous prompt, so a long pause between sends is visible on the rail.
                        const gap = minimapGapLabel(items[index - 1]?.createdAt, item.createdAt);
                        const isActive = item.id === activeId;

                        return (
                            <li className="flex w-full items-center justify-end gap-0.5" key={item.id}>
                                {gap && (
                                    <span aria-hidden="true" className="text-muted-foreground pointer-events-none text-[10px] tabular-nums">
                                        {gap}
                                    </span>
                                )}
                                <Tooltip>
                                    <TooltipTrigger
                                        render={
                                            <button
                                                aria-current={isActive ? "location" : undefined}
                                                aria-label={t`Jump to prompt ${promptNumber}: ${preview}`}
                                                className="group focus-visible:ring-ring flex h-4 w-6 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                                                data-active={isActive}
                                                onClick={() => scrollToMessage(item.id, { threadId })}
                                                type="button"
                                            >
                                                <span aria-hidden="true" className="relative h-0.5 w-4 rounded-full">
                                                    <span className="bg-muted-foreground/40 group-hover:bg-foreground absolute inset-0 rounded-full motion-safe:transition-colors" />
                                                    <span className="bg-foreground absolute inset-0 rounded-full opacity-0 group-data-[active=true]:opacity-100 motion-safe:transition-opacity motion-safe:duration-150" />
                                                </span>
                                            </button>
                                        }
                                    />
                                    <TooltipContent className="max-w-xs" side="left">
                                        {item.createdAt !== undefined && (
                                            <time
                                                className="text-muted-foreground block text-[10px] tabular-nums"
                                                dateTime={new Date(item.createdAt).toISOString()}
                                            >
                                                {formatMessageTime(item.createdAt, i18n.locale)}
                                            </time>
                                        )}
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
