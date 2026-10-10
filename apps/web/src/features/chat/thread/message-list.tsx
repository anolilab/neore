"use client";

/**
 * MessageList - Renders all messages in a thread
 *
 * Maps over UIMessage[] directly from context and renders each message.
 * Supports edit mode by rendering edit composer for the edited message.
 *
 * Streaming:
 * - Uses activeStreamId from Lunora query for reliable stream detection
 * - Shows StreamingPlaceholder when there's an active stream and no completed assistant message yet
 * - No complex message counting - Lunora is the single source of truth
 *
 * Performance optimizations:
 * - Throttled updates during streaming (60fps max)
 * - Memoized message items
 * - Long threads (> VIRTUALIZE_THRESHOLD) virtualize their OLDER messages behind
 *   the `neore:virtualize-messages` localStorage flag. The newest
 *   ALWAYS_MOUNTED_TAIL messages and the streaming placeholder are always real
 *   DOM, so stick-to-bottom (ThreadViewport) and the live region never see the
 *   virtualizer. Cmd/Ctrl+F turns virtualization off for the rest of the visit
 *   so find-in-page can reach every loaded message.
 *
 * Jump to a message: `#message-<id>` in the URL, or `scrollToMessage(id, { threadId })`.
 * Pins and message-search results use the latter.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { Virtualizer } from "@tanstack/react-virtual";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence } from "motion/react";
import type { FC, ReactNode } from "react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { useChatIsStreaming, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";
import type { UIMessage } from "@/lib/agent";
import { showInfo } from "@/lib/toast";

import LoadMoreTrigger from "./load-more-trigger";
import MessageItem from "./message-item";
import type { MessagePosition, WindowPlan } from "./message-windowing";
import { getWindowPlan, parseMessageHash, readVirtualizeFlag, resolveJumpMessageId, resolveJumpTarget, shouldAnimateEntrance } from "./message-windowing";
import { selectStreamIdToShow, selectStreamTokenFor } from "./stream-to-show";
import { StreamingPlaceholder, ThinkingPlaceholder } from "./streaming-placeholder";

/**
 * Throttled messages hook for streaming optimization
 *
 * During streaming, limits updates to 60fps to prevent excessive re-renders.
 * When not streaming, updates immediately.
 */
const THROTTLE_MS = 16; // ~60fps

// Rough height of an unmeasured row; the virtualizer corrects it on first measure.
const ESTIMATED_ROW_HEIGHT = 160;

/** How many older pages a jump may pull in looking for its target, and how big each is. */
const JUMP_MAX_PAGES = 10;
const JUMP_PAGE_SIZE = 50;

interface ScrollToMessageDetail {
    messageId: string;
    /** Where the message sits, for a stored step that renders merged into an earlier message. */
    position?: MessagePosition;
    threadId?: string;
}

const scrollToMessageChannel = createRequestChannel<ScrollToMessageDetail>();

interface PendingJump {
    messageId: string;
    pagesLoaded: number;
    position?: MessagePosition;
    /** Set when the jump was requested for a thread that may not be open yet. */
    threadId?: string;
}

/**
 * Scrolls the open thread to a message and focuses it, mounting it first if it
 * is virtualized and loading older pages if it is not loaded yet. Pass
 * `threadId` when the request races a navigation to that thread: the jump then
 * waits until that thread's messages are showing.
 */
export const scrollToMessage = (messageId: string, options: { position?: MessagePosition; threadId?: string } = {}): void => {
    scrollToMessageChannel.request({ messageId, ...options });
};

// The flag is read once per mount; flipping it takes a reload.
const subscribeToNothing = (): (() => void) => () => {};

const useThrottledMessages = (messages: UIMessage[], isStreaming: boolean): UIMessage[] => {
    const [throttledMessages, setThrottledMessages] = useState(messages);
    const lastUpdateRef = useRef(0);
    const pendingUpdateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const previousMessagesLengthRef = useRef(messages.length);

    useEffect(() => {
        // Always update immediately if:
        // - Not streaming
        // - Message count changed (new message added/completed)
        // - Last message status changed to "success" (stream completed)
        const lastMessage = messages.at(-1);
        const hasCompletedMessage = lastMessage?.role === "assistant" && lastMessage?.status === "success";
        const isMessageCountChanged = messages.length !== previousMessagesLengthRef.current;

        previousMessagesLengthRef.current = messages.length;

        if (!isStreaming || isMessageCountChanged || hasCompletedMessage) {
            if (pendingUpdateRef.current) {
                clearTimeout(pendingUpdateRef.current);
                pendingUpdateRef.current = null;
            }

            setThrottledMessages(messages);

            return undefined;
        }

        const now = Date.now();
        const timeSinceLastUpdate = now - lastUpdateRef.current;

        // If enough time has passed, update immediately
        if (timeSinceLastUpdate >= THROTTLE_MS) {
            lastUpdateRef.current = now;
            setThrottledMessages(messages);

            return undefined;
        }

        // Otherwise, schedule an update
        if (pendingUpdateRef.current) {
            clearTimeout(pendingUpdateRef.current);
        }

        pendingUpdateRef.current = setTimeout(() => {
            lastUpdateRef.current = Date.now();
            setThrottledMessages(messages);
            pendingUpdateRef.current = null;
        }, THROTTLE_MS - timeSinceLastUpdate);

        return () => {
            if (pendingUpdateRef.current) {
                clearTimeout(pendingUpdateRef.current);
            }
        };
    }, [messages, isStreaming]);

    return throttledMessages;
};

/**
 * Ids present once the thread's first page landed. Messages outside this set
 * arrived live and may animate in; `null` while the thread is still loading, so
 * the first page itself never animates. Resets when the thread changes.
 */
const useInitialMessageIds = (messages: UIMessage[], messagesReady: boolean): ReadonlySet<string> | null => {
    const [initialIds, setInitialIds] = useState<ReadonlySet<string> | null>(null);

    // Adjusted during render (not in an effect) so the first committed page already carries the set.
    if (!messagesReady && initialIds !== null) {
        setInitialIds(null);
    } else if (messagesReady && initialIds === null && messages.length > 0) {
        setInitialIds(new Set(messages.map((message) => message.id)));
    }

    return initialIds;
};

/** Cmd/Ctrl+F: the browser can only find text that is in the DOM, so mount everything. */
const useFindInPageOverride = (): boolean => {
    const [isFindRequested, setIsFindRequested] = useState(false);

    useEffect(() => {
        if (isFindRequested) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
                setIsFindRequested(true);
            }
        };

        globalThis.addEventListener("keydown", handleKeyDown);

        return () => globalThis.removeEventListener("keydown", handleKeyDown);
    }, [isFindRequested]);

    return isFindRequested;
};

type RenderRow = (message: UIMessage, index: number) => ReactNode;

interface VirtualizedHeadProps {
    /** Changes whenever content above the list may have moved (e.g. the load-more spinner). */
    layoutKey: string;
    messages: UIMessage[];
    onVirtualizer: (virtualizer: Virtualizer<HTMLElement, Element> | null) => void;
    renderRow: RenderRow;
}

/**
 * The older part of a long thread. Rows are absolutely positioned inside a
 * spacer sized to the virtualizer's total, measured as they mount (heights vary
 * a lot). Scrolls with ThreadViewport's element, offset by `scrollMargin`.
 */
const VirtualizedHead: FC<VirtualizedHeadProps> = ({ layoutKey, messages, onVirtualizer, renderRow }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
    const [scrollMargin, setScrollMargin] = useState(0);

    // The scroll element belongs to ThreadViewport; find it rather than threading a ref through Thread.
    useLayoutEffect(() => {
        setScrollElement(containerRef.current?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? null);
    }, []);

    // Content above the list (padding, the load-more spinner) shifts where row 0 starts.
    useLayoutEffect(() => {
        const container = containerRef.current;

        if (!container || !scrollElement) {
            return;
        }

        const margin = container.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top + scrollElement.scrollTop;

        setScrollMargin((previous) => (Math.abs(margin - previous) > 1 ? margin : previous));
    }, [layoutKey, messages.length, scrollElement]);

    const getScrollElement = useCallback(() => scrollElement, [scrollElement]);
    const estimateSize = useCallback(() => ESTIMATED_ROW_HEIGHT, []);
    const getItemKey = useCallback((index: number) => messages[index]?.id ?? index, [messages]);

    const virtualizer = useVirtualizer<HTMLElement, Element>({
        count: messages.length,
        estimateSize,
        getItemKey,
        getScrollElement,
        overscan: 4,
        scrollMargin,
    });

    useEffect(() => {
        onVirtualizer(virtualizer);

        return () => onVirtualizer(null);
    }, [onVirtualizer, virtualizer]);

    return (
        <div className="relative w-full" ref={containerRef} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
                const message = messages[item.index];

                if (!message) {
                    return null;
                }

                return (
                    <div
                        className="absolute top-0 left-0 w-full"
                        data-index={item.index}
                        key={item.key}
                        ref={virtualizer.measureElement}
                        style={{ transform: `translateY(${item.start - scrollMargin}px)` }}
                    >
                        {renderRow(message, item.index)}
                    </div>
                );
            })}
        </div>
    );
};

interface MessageListProps {
    className?: string;
    editComposerComponent?: FC<{ message: UIMessage }>;
    emptyComponent?: ReactNode;
    maxWidth?: string;
}

/**
 * Main MessageList component
 */
const MessageList: FC<MessageListProps> = memo(({ className, editComposerComponent: EditComposer, emptyComponent, maxWidth = "65ch" }) => {
    const { t } = useLingui();
    const { loadMore, messages: rawMessages, messagesReady, messagesStatus } = useChatMessages();
    const { threadId } = useChatThread();
    const { activeStreamId, gatewayUrl, isStreaming, pendingStreamId, streamToken } = useChatIsStreaming();
    const editingMessageId = useChatUIStore((state) => state.editingMessageId);

    // Use throttled messages during streaming for 60fps rendering
    const messages = useThrottledMessages(rawMessages, isStreaming);
    const initialIds = useInitialMessageIds(messages, messagesReady);

    // The server snapshot is `false`: localStorage does not exist during SSR.
    const isVirtualizeFlagOn = useSyncExternalStore(subscribeToNothing, readVirtualizeFlag, () => false);

    const isFindRequested = useFindInPageOverride();
    const plan: WindowPlan = getWindowPlan(messages.length, { enabled: isVirtualizeFlagOn && !isFindRequested });

    // Jump-to-message. Refs hold the latest plan/messages so the listener is attached once.
    const virtualizerRef = useRef<Virtualizer<HTMLElement, Element> | null>(null);
    const jumpStateRef = useRef({ messages, plan });

    useLayoutEffect(() => {
        jumpStateRef.current = { messages, plan };
    });

    const handleVirtualizer = useCallback((virtualizer: Virtualizer<HTMLElement, Element> | null) => {
        virtualizerRef.current = virtualizer;
    }, []);

    const jumpTo = useCallback((requestedId: string, position?: MessagePosition): boolean => {
        const { messages: currentMessages, plan: currentPlan } = jumpStateRef.current;
        const messageId = resolveJumpMessageId(currentMessages, requestedId, position);

        if (!messageId) {
            return false;
        }

        const target = resolveJumpTarget(
            currentMessages.map((message) => message.id),
            messageId,
            currentPlan,
        );

        if (target.kind === "missing") {
            return false;
        }

        const reveal = () => {
            const element = document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(messageId)}"]`);

            if (!element) {
                return;
            }

            element.scrollIntoView({ block: "center" });
            // Move focus too, so keyboard and screen-reader users land where sighted users do.
            element.focus({ preventScroll: true });
        };

        if (target.kind === "head" && virtualizerRef.current) {
            // Mount the row first, then let it measure before the precise scroll.
            virtualizerRef.current.scrollToIndex(target.index, { align: "center" });
            requestAnimationFrame(() => requestAnimationFrame(reveal));
        } else {
            reveal();
        }

        return true;
    }, []);

    // A jump target may not be loaded yet (paginated): remember it, pull older
    // pages until it appears or JUMP_MAX_PAGES is spent, then jump. Scoped to a
    // thread so a request made while navigating never pages through the
    // previous thread's history.
    const pendingJumpRef = useRef<PendingJump | undefined>(undefined);
    const [jumpRequest, setJumpRequest] = useState(0);
    const jumpContextRef = useRef({ loadMore, notFound: () => {} });

    useLayoutEffect(() => {
        jumpContextRef.current = { loadMore, notFound: () => showInfo(t`That message could not be found in this conversation.`) };
    });

    useEffect(() => {
        const request = ({ messageId, position, threadId: targetThreadId }: ScrollToMessageDetail) => {
            pendingJumpRef.current = { messageId, pagesLoaded: 0, position, threadId: targetThreadId };
            setJumpRequest((value) => value + 1);
        };
        const readHash = (): PendingJump | undefined => {
            const messageId = parseMessageHash(globalThis.location.hash);

            return messageId ? { messageId, pagesLoaded: 0 } : undefined;
        };
        const handleHash = () => {
            const pending = readHash();

            if (pending) {
                request(pending);
            }
        };

        // On mount the pending-jump effect runs anyway, so only the ref needs setting.
        pendingJumpRef.current = readHash();
        globalThis.addEventListener("hashchange", handleHash);

        // Takes a request made before this list mounted as well as every later one.
        const unsubscribe = scrollToMessageChannel.consume(request);

        return () => {
            globalThis.removeEventListener("hashchange", handleHash);
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        const pending = pendingJumpRef.current;

        if (!pending || !messagesReady || (pending.threadId !== undefined && pending.threadId !== threadId)) {
            return undefined;
        }

        // Wait a frame so ThreadViewport's initial scroll-to-bottom does not override the jump.
        const frame = requestAnimationFrame(() => {
            if (pendingJumpRef.current !== pending) {
                return;
            }

            if (jumpTo(pending.messageId, pending.position)) {
                pendingJumpRef.current = undefined;

                return;
            }

            if (messagesStatus === "LoadingMore" || messagesStatus === "LoadingFirstPage") {
                return; // This effect re-runs when the page lands.
            }

            if (messagesStatus === "CanLoadMore" && pending.pagesLoaded < JUMP_MAX_PAGES) {
                pending.pagesLoaded += 1;
                jumpContextRef.current.loadMore(JUMP_PAGE_SIZE);

                return;
            }

            pendingJumpRef.current = undefined;
            jumpContextRef.current.notFound();
        });

        return () => cancelAnimationFrame(frame);
    }, [jumpRequest, jumpTo, messages.length, messagesReady, messagesStatus, threadId]);

    // Check if the last message is a completed assistant message.
    // We also require !activeStreamId because tool-result messages are stored with
    // status "success" mid-stream, and we must not dismiss the SSE placeholder early.
    const lastMessage = messages.at(-1);
    const hasCompletedAssistantMessage = lastMessage?.role === "assistant" && lastMessage?.status === "success" && !activeStreamId;

    // The live stream, or the one this client just started before that reports.
    const streamIdToShow = selectStreamIdToShow(activeStreamId, pendingStreamId, lastMessage);
    const streamTokenToShow = selectStreamTokenFor(streamIdToShow, pendingStreamId, streamToken);

    // Determine if we should show the streaming placeholder
    // Show if:
    // 1. We have a streamId AND the last message isn't a completed assistant, OR
    // 2. isStreaming is true (includes optimistic regenerating state) AND no completed assistant
    const showPlaceholder = (!!streamIdToShow || isStreaming) && !hasCompletedAssistantMessage;

    // Show empty component only if no messages AND no active/recent stream
    if (!showPlaceholder && messages.length === 0) {
        return emptyComponent ? <>{emptyComponent}</> : null;
    }

    // aria-setsize: screen readers report the full thread length even when rows are virtualized.
    const setSize = messages.length + (showPlaceholder ? 1 : 0);

    const renderMessage = (message: UIMessage, index: number): ReactNode => {
        // Use AnimatePresence only for edit mode transitions
        if (editingMessageId === message.id && EditComposer) {
            return (
                <AnimatePresence mode="wait">
                    <EditComposer key={`${message.id}-edit`} message={message} />
                </AnimatePresence>
            );
        }

        const isLastMessage = index === messages.length - 1;
        const messageIsStreaming = isStreaming && isLastMessage && message.role === "assistant";

        return <MessageItem index={index} isLast={isLastMessage && !showPlaceholder} isStreaming={messageIsStreaming} maxWidth={maxWidth} message={message} />;
    };

    const renderRow: RenderRow = (message, index) => {
        const isLastMessage = index === messages.length - 1;

        // Skip rendering incomplete assistant messages when the placeholder is showing
        // This prevents duplicate rendering during streaming
        const isIncompleteAssistant = message.role === "assistant" && message.status !== "success";

        if (showPlaceholder && isLastMessage && isIncompleteAssistant) {
            return null;
        }

        const isEntering =
            initialIds !== null && shouldAnimateEntrance({ index, initialIds, messageId: message.id, role: message.role, total: messages.length });

        return (
            <div
                aria-posinset={index + 1}
                aria-setsize={setSize}
                className={cn("outline-none", isEntering && "animate-in fade-in slide-in-from-bottom-2 duration-200")}
                data-list-message-id={message.id}
                role="listitem"
                tabIndex={-1}
            >
                {renderMessage(message, index)}
            </div>
        );
    };

    const tailStart = plan.virtualized ? plan.headCount : 0;

    return (
        <>
            {/* Loading indicator — trigger lives in ThreadViewport's scroll handler */}
            <LoadMoreTrigger status={messagesStatus} />

            <div className={cn("message-list flex flex-col", className)} role="list" style={{ "--thread-max-width": maxWidth } as React.CSSProperties}>
                {plan.virtualized && (
                    <VirtualizedHead
                        layoutKey={messagesStatus}
                        messages={messages.slice(0, plan.headCount)}
                        onVirtualizer={handleVirtualizer}
                        renderRow={renderRow}
                    />
                )}

                {messages.slice(tailStart).map((message, offset) => {
                    const index = tailStart + offset;

                    return <Fragment key={message.id}>{renderRow(message, index)}</Fragment>;
                })}

                {/* Placeholders stay in the always-mounted tail so their live region is never virtualized away. */}
                {showPlaceholder && (
                    <div aria-posinset={setSize} aria-setsize={setSize} role="listitem">
                        {/* Gateway streaming placeholder - uses MessageContent for identical rendering */}
                        {streamIdToShow && gatewayUrl && streamTokenToShow && (
                            <StreamingPlaceholder gatewayUrl={gatewayUrl} maxWidth={maxWidth} streamId={streamIdToShow} streamToken={streamTokenToShow} />
                        )}
                        {/* Simple "Thinking..." placeholder when regenerating but no stream yet */}
                        {!streamIdToShow && <ThinkingPlaceholder maxWidth={maxWidth} />}
                    </div>
                )}
            </div>
        </>
    );
});

MessageList.displayName = "MessageList";

export default MessageList;
