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
 * - Every loaded message stays mounted, so whatever a row holds (a draft, a
 *   dialog, focus, a selection, playing media, read aloud) survives scrolling, and
 *   find-in-page and screen readers reach all of it. Rows off screen are cheap
 *   instead: `content-visibility: auto` (styles.css) skips their layout and paint,
 *   and `contain-intrinsic-size: auto` keeps each one's last real height.
 *
 * Jump to a message: `#message-<id>` in the URL, or `scrollToMessage(id, { threadId })`.
 * Pins and message-search results use the latter.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { AnimatePresence } from "motion/react";
import type { FC, ReactNode } from "react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useChatIsStreaming, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ScrollToMessageDetail } from "@/features/chat/core/utils/scroll-to-message";
import { scrollToMessageChannel } from "@/features/chat/core/utils/scroll-to-message";
import { GoalBanner, GoalReviewNote, GoalVerdictNote } from "@/features/chat/goal/goal-notes";
import { anchorVerdicts, goalReviewNotes, withoutGoalInstructions, withoutNotedVerdicts } from "@/features/chat/goal/goal-view";
import { useThreadGoal } from "@/features/chat/goal/use-thread-goal";
import type { UIMessage } from "@/lib/agent";
import { showInfo } from "@/lib/toast";

import LoadMoreTrigger from "./load-more-trigger";
import MessageItem from "./message-item";
import type { MessagePosition } from "./message-windowing";
import { parseMessageHash, resolveJumpMessageId, shouldAnimateEntrance, shouldLoadOlderForJump } from "./message-windowing";
import { RateLimitPauseNotice } from "./rate-limit-pause-notice";
import { selectStreamIdToShow, selectStreamTokenFor } from "./stream-to-show";
import { StreamingPlaceholder, ThinkingPlaceholder } from "./streaming-placeholder";

/**
 * Frames a jump keeps re-centring its row. Rows above it that were never rendered are counted at their estimated
 * height (`contain-intrinsic-size`); as they near the viewport they take their real one and push the row.
 */
const JUMP_SETTLE_FRAMES = 10;

/** How big each older page a jump pulls in looking for its target is. */
const JUMP_PAGE_SIZE = 50;

interface PendingJump {
    focus?: boolean;
    messageId: string;
    pagesLoaded: number;
    position?: MessagePosition;
    /** Set when the jump was requested for a thread that may not be open yet. */
    threadId?: string;
}

// Kept here as well: the callers that render inside the list import it from the list.
export { scrollToMessage } from "@/features/chat/core/utils/scroll-to-message";

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

/** Where a jump to a loaded message lands: its row, or the streaming item for the reply still streaming (it has no row). */
const findJumpTarget = (list: HTMLElement | null, messages: ReadonlyArray<{ id: string }>, messageId: string): HTMLElement | null => {
    const row = document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(messageId)}"]`);

    if (row || messages.at(-1)?.id !== messageId) {
        return row;
    }

    return list?.querySelector<HTMLElement>("[data-list-streaming]") ?? null;
};

type RenderRow = (message: UIMessage, index: number) => ReactNode;

interface MessageListProps {
    className?: string;
    editComposerComponent?: FC<{ message: UIMessage }>;
    emptyComponent?: ReactNode;
    maxWidth?: string;
}

/**
 * Main MessageList component
 */
const MessageList: FC<MessageListProps> = memo(({ className, editComposerComponent: EditComposer, emptyComponent, maxWidth: maxWidthProp }) => {
    const maxWidth = maxWidthProp ?? "65ch";
    const { t } = useLingui();
    const { loadMore, messages: threadMessages, messagesReady, messagesStatus } = useChatMessages();
    const { threadId } = useChatThread();
    // A goal's own instructions are not the user's messages: each shows as a "Review: …" note after the reply it
    // followed, and the verdicts that note already says sit under the replies they judged.
    const goal = useThreadGoal(threadId);
    const messages = withoutGoalInstructions(threadMessages);
    const reviewNotes = goalReviewNotes(threadMessages);
    const verdictAnchors = goal ? anchorVerdicts(messages, withoutNotedVerdicts(messages, goal.verdicts, reviewNotes)) : null;
    const { activeStreamId, gatewayUrl, isStreaming, pause, pendingStreamId, streamToken } = useChatIsStreaming();
    const editingMessageId = useChatUIStore((state) => state.editingMessageId);

    const initialIds = useInitialMessageIds(messages, messagesReady);

    // Jump-to-message. A ref holds the latest messages so the listener is attached once.
    const jumpStateRef = useRef({ messages, threadId });

    useLayoutEffect(() => {
        jumpStateRef.current = { messages, threadId };
    });

    const listRef = useRef<HTMLDivElement>(null);

    // Each jump's generation: a newer request, or unmounting, stops an older jump still re-centring its row.
    const jumpGenerationRef = useRef(0);

    useEffect(
        () => () => {
            jumpGenerationRef.current += 1;
        },
        [],
    );

    const jumpTo = useCallback((requestedId: string, position?: MessagePosition, focus = true): boolean => {
        const messageId = resolveJumpMessageId(jumpStateRef.current.messages, requestedId, position);
        const element = messageId ? findJumpTarget(listRef.current, jumpStateRef.current.messages, messageId) : null;

        if (!element) {
            return false;
        }

        jumpGenerationRef.current += 1;

        const generation = jumpGenerationRef.current;

        element.scrollIntoView({ block: "center" });

        // Move focus too, so keyboard and screen-reader users land where sighted users do.
        if (focus) {
            // Marks the row a jump landed on, so it alone shows a focus ring; a row focused by a click in its text does not.
            element.dataset.jumped = "";
            element.addEventListener(
                "blur",
                () => {
                    delete element.dataset.jumped;
                },
                { once: true },
            );
            element.focus({ preventScroll: true });
        }

        // Re-centre whenever the row moved, for every frame of the budget: rows above it render at their real height as
        // they come into view, and one can still change after a still frame (a late image, a skip that ends later).
        let framesLeft = JUMP_SETTLE_FRAMES;
        let previousTop = NaN;
        const settle = () => {
            if (jumpGenerationRef.current !== generation || !element.isConnected) {
                return;
            }

            const { top } = element.getBoundingClientRect();

            if (Number.isNaN(previousTop) || Math.abs(top - previousTop) >= 1) {
                element.scrollIntoView({ block: "center" });
            }

            previousTop = top;
            framesLeft -= 1;

            if (framesLeft > 0) {
                requestAnimationFrame(settle);
            }
        };

        requestAnimationFrame(settle);

        return true;
    }, []);

    // A jump target may not be loaded yet (paginated): remember it, pull older
    // pages until it appears or the page budget is spent (see shouldLoadOlderForJump), then jump. Scoped to a
    // thread so a request made while navigating never pages through the
    // previous thread's history.
    const pendingJumpRef = useRef<PendingJump | undefined>(undefined);
    const [jumpRequest, setJumpRequest] = useState(0);
    const jumpContextRef = useRef({ loadMore, notFound: () => {} });

    useLayoutEffect(() => {
        jumpContextRef.current = { loadMore, notFound: () => showInfo(t`That message could not be found in this conversation.`) };
    });

    const requestJump = useCallback(({ focus, messageId, position, threadId: targetThreadId }: ScrollToMessageDetail) => {
        // A request stops the re-centring an earlier jump still has pending, even before its own target loads.
        jumpGenerationRef.current += 1;
        pendingJumpRef.current = { focus, messageId, pagesLoaded: 0, position, threadId: targetThreadId };
        setJumpRequest((value) => value + 1);
    }, []);

    useEffect(() => {
        const readHash = (): PendingJump | undefined => {
            const messageId = parseMessageHash(globalThis.location.hash);

            return messageId ? { messageId, pagesLoaded: 0 } : undefined;
        };
        const handleHash = () => {
            const pending = readHash();

            if (pending) {
                requestJump(pending);
            }
        };

        // On mount the pending-jump effect runs anyway, so only the ref needs setting.
        pendingJumpRef.current = readHash();
        globalThis.addEventListener("hashchange", handleHash);

        return () => {
            globalThis.removeEventListener("hashchange", handleHash);
        };
    }, [requestJump]);

    // Takes a request made before this list mounted as well as every later one. A request for another thread is left for the list
    // that shows it, so a split pane that is not focused cannot take the focused pane's jump. The channel only redelivers on a store
    // change, so a thread change re-subscribes: a request this list rejected while the previous thread showed is taken then.
    useEffect(() => {
        const unsubscribe = scrollToMessageChannel.consume(
            requestJump,
            (payload) => payload.threadId === undefined || payload.threadId === jumpStateRef.current.threadId,
        );

        return unsubscribe;
    }, [requestJump, threadId]);

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

            if (jumpTo(pending.messageId, pending.position, pending.focus)) {
                // A request made while this one landed is left for the next run.
                if (pendingJumpRef.current === pending) {
                    pendingJumpRef.current = undefined;
                }

                return;
            }

            if (messagesStatus === "LoadingMore" || messagesStatus === "LoadingFirstPage") {
                return; // This effect re-runs when the page lands.
            }

            if (messagesStatus === "CanLoadMore" && shouldLoadOlderForJump(pending.pagesLoaded, jumpStateRef.current.messages, pending.position)) {
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

    // aria-setsize: screen readers report the full thread length, placeholder included.
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

        // One list item per message: the goal's banner and notes belong to it, so the list's count and positions stay the messages'.
        // A jump focuses the item; after a keyboard action a ring shows where it landed (inset, so the scroller cannot clip it).
        return (
            <div
                aria-posinset={index + 1}
                aria-setsize={setSize}
                className={cn(
                    "data-jumped:focus-visible:ring-ring rounded-lg outline-none data-jumped:focus-visible:ring-2 data-jumped:focus-visible:ring-inset",
                    isEntering && "animate-in fade-in slide-in-from-bottom-2 duration-200",
                )}
                data-list-message-id={message.id}
                role="listitem"
                tabIndex={-1}
            >
                {goal && threadId && goal.startMessageId === message.id && <GoalBanner goal={goal} maxWidth={maxWidth} threadId={threadId} />}
                {renderMessage(message, index)}
                {reviewNotes.get(message.id)?.map((reason, noteIndex) => (
                    <GoalReviewNote key={`${message.id}-review-${String(noteIndex)}`} maxWidth={maxWidth} reason={reason} />
                ))}
                {goal &&
                    verdictAnchors
                        ?.get(message.id)
                        ?.map((verdict) => <GoalVerdictNote goal={goal} key={verdict.round} maxWidth={maxWidth} verdict={verdict} />)}
            </div>
        );
    };

    return (
        <>
            {/* Loading indicator — trigger lives in ThreadViewport's scroll handler */}
            <LoadMoreTrigger status={messagesStatus} />

            <div
                className={cn("message-list flex flex-col", className)}
                ref={listRef}
                role="list"
                style={{ "--thread-max-width": maxWidth } as React.CSSProperties}
            >
                {messages.map((message, index) => (
                    <Fragment key={message.id}>{renderRow(message, index)}</Fragment>
                ))}

                {/* The placeholder is not a message row: its live region is never skipped (`content-visibility` is on rows only). */}
                {showPlaceholder && (
                    <div
                        aria-posinset={setSize}
                        aria-setsize={setSize}
                        className="data-jumped:focus-visible:ring-ring rounded-lg outline-none data-jumped:focus-visible:ring-2 data-jumped:focus-visible:ring-inset"
                        data-list-streaming=""
                        role="listitem"
                        tabIndex={-1}
                    >
                        {/* Gateway streaming placeholder - uses MessageContent for identical rendering */}
                        {/* Without a gateway token (a host-run turn, or a stream another client started) it reads the persisted body. */}
                        {streamIdToShow && (
                            <StreamingPlaceholder
                                {...(gatewayUrl && streamTokenToShow && { gatewayUrl, streamToken: streamTokenToShow })}
                                key={streamIdToShow}
                                maxWidth={maxWidth}
                                streamId={streamIdToShow}
                            />
                        )}
                        {/* The run is waiting out a provider's rate limit: when it resumes, and what a person can do meanwhile. */}
                        {streamIdToShow && pause && threadId && (
                            <RateLimitPauseNotice className="mx-auto w-full max-w-(--thread-max-width) pb-3" pause={pause} threadId={threadId} />
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
