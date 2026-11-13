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
 * - Long threads (> VIRTUALIZE_THRESHOLD) virtualize their OLDER messages
 *   (`neore:virtualize-messages` = "0" in localStorage turns it off). The newest
 *   ALWAYS_MOUNTED_TAIL messages and the streaming placeholder are always real
 *   DOM, so stick-to-bottom (ThreadViewport) and the live region never see the
 *   virtualizer. The thread's own find bar searches the data and jumps, so it
 *   reaches unmounted rows. A find key the BROWSER gets (Cmd/Ctrl+F, F3,
 *   Cmd/Ctrl+G) or the "Show all earlier messages" control (keyboard,
 *   screen readers, find opened from a menu) mounts every loaded message
 *   for the rest of the visit.
 *
 * Jump to a message: `#message-<id>` in the URL, or `scrollToMessage(id, { threadId })`.
 * Pins and message-search results use the latter.
 */

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import type { Virtualizer } from "@tanstack/react-virtual";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence } from "motion/react";
import type { FC, ReactNode, RefObject } from "react";
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

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
import type { MessagePosition, WindowPlan } from "./message-windowing";
import {
    getWindowPlan,
    holdPinnedTail,
    isBrowserFindKey,
    parseMessageHash,
    readVirtualizeFlag,
    resolveJumpMessageId,
    resolveJumpTarget,
    shouldAnimateEntrance,
    shouldLoadOlderForJump,
    withPinnedRows,
} from "./message-windowing";
import { RateLimitPauseNotice } from "./rate-limit-pause-notice";
import { useEndReadAloudWithMessages } from "./read-aloud-speech";
import { RowMessageIdContext, usePinnedRowIds } from "./row-pins";
import { selectStreamIdToShow, selectStreamTokenFor } from "./stream-to-show";
import { StreamingPlaceholder, ThinkingPlaceholder } from "./streaming-placeholder";

// Rough height of an unmeasured row; the virtualizer corrects it on first measure.
const ESTIMATED_ROW_HEIGHT = 160;

/** Frames a jump into the virtualized head waits for its row to mount before giving up. */
const HEAD_REVEAL_FRAMES = 30;

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

// The flag is read once per mount; flipping it takes a reload.
const subscribeToNothing = (): (() => void) => () => {};

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

/**
 * Whether every loaded message is mounted for the rest of this visit: the browser's find can only find
 * text that is in the DOM, and keyboard and screen-reader users move through the DOM.
 *
 * Set by a find key the browser gets (`isBrowserFindKey`). On a thread page the find-in-thread shortcut
 * takes Cmd/Ctrl+F on `document` and prevents the default; this listener is on the window, so it runs
 * after that one and sees whether the browser still gets the key. Find opened from a menu sends no key:
 * the "Show all earlier messages" control at the top of the list (`showAll`) covers that, and keyboard use.
 */
const useShowAllMessages = (): { isAllShown: boolean; showAll: () => void } => {
    const [isAllShown, setIsAllShown] = useState(false);

    useEffect(() => {
        if (isAllShown) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            if (isBrowserFindKey(event) && !event.defaultPrevented) {
                setIsAllShown(true);
            }
        };

        globalThis.addEventListener("keydown", handleKeyDown);

        return () => globalThis.removeEventListener("keydown", handleKeyDown);
    }, [isAllShown]);

    const showAll = useCallback(() => setIsAllShown(true), []);

    return { isAllShown, showAll };
};

/** The first and last row a text selection in the list touches, by message id. */
interface SelectedRows {
    firstId: string;
    lastId: string;
}

const ROW_SELECTOR = "[data-list-message-id]";

/** Where a selection end sits: its row's id, or which side of the list it lies on when it is outside the list. */
const rowEdge = (list: HTMLElement, node: Node | null): string | "after" | "before" | undefined => {
    if (!node) {
        return undefined;
    }

    if (!list.contains(node)) {
        const around = document.createRange();

        around.selectNode(list);

        return around.comparePoint(node, 0) < 0 ? "before" : "after";
    }

    const element = node instanceof Element ? node : node.parentElement;

    return element?.closest<HTMLElement>(ROW_SELECTOR)?.dataset.listMessageId;
};

const readSelectedRows = (list: HTMLElement): SelectedRows | null => {
    const selection = document.getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !selection.getRangeAt(0).intersectsNode(list)) {
        return null;
    }

    const rows = list.querySelectorAll<HTMLElement>(ROW_SELECTOR);
    const resolve = (edge: string | undefined): string | undefined => {
        if (edge === "before") {
            return rows[0]?.dataset.listMessageId;
        }

        if (edge === "after") {
            return rows[rows.length - 1]?.dataset.listMessageId;
        }

        return edge;
    };
    // The range runs in document order, whichever way the selection was made.
    const range = selection.getRangeAt(0);
    const firstId = resolve(rowEdge(list, range.startContainer));
    const lastId = resolve(rowEdge(list, range.endContainer));

    return firstId === undefined || lastId === undefined ? null : { firstId, lastId };
};

/**
 * The rows a text selection in the list spans. The virtualizer keeps them mounted while it lasts, so
 * scrolling a selected older reply out of view does not cut the selection; windowing resumes once it clears.
 */
const useSelectedRows = (listRef: RefObject<HTMLElement | null>): SelectedRows | null => {
    const [selected, setSelected] = useState<SelectedRows | null>(null);

    useEffect(() => {
        const handleSelectionChange = () => {
            const list = listRef.current;
            const next = list ? readSelectedRows(list) : null;

            setSelected((previous) => (previous?.firstId === next?.firstId && previous?.lastId === next?.lastId ? previous : next));
        };

        document.addEventListener("selectionchange", handleSelectionChange);

        return () => document.removeEventListener("selectionchange", handleSelectionChange);
    }, [listRef]);

    return selected;
};

/**
 * Rows held mounted, as ascending indexes into `messages`: every row a text selection spans, and the
 * rows something inside them pinned (`row-pins.ts`).
 */
const pinnedIndexes = (messages: ReadonlyArray<UIMessage>, selected: SelectedRows | null, pinnedIds: ReadonlySet<string>): number[] => {
    const indexes: number[] = [];

    if (pinnedIds.size > 0) {
        for (const [index, message] of messages.entries()) {
            if (pinnedIds.has(message.id)) {
                indexes.push(index);
            }
        }
    }

    if (selected) {
        const first = messages.findIndex((message) => message.id === selected.firstId);
        const last = messages.findIndex((message) => message.id === selected.lastId);

        if (first !== -1 && last !== -1) {
            for (let index = Math.min(first, last); index <= Math.max(first, last); index += 1) {
                indexes.push(index);
            }
        }
    }

    return [...new Set(indexes)].toSorted((a, b) => a - b);
};

const NO_PINS: ReadonlyArray<number> = [];

const sameIndexes = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean => a.length === b.length && a.every((index, at) => index === b[at]);

/**
 * `next`, or the array the last render used when it holds the same indexes: the virtualizer's range
 * extractor depends on it, and streaming re-renders the list on every chunk.
 */
const useStableIndexes = (next: ReadonlyArray<number>): ReadonlyArray<number> => {
    const [kept, setKept] = useState(NO_PINS);
    let value = next;

    if (next.length === 0) {
        value = NO_PINS;
    } else if (sameIndexes(kept, next)) {
        value = kept;
    }

    // Adjusted during render, like `useInitialMessageIds`, so this render already uses it.
    if (value !== kept) {
        setKept(value);
    }

    return value;
};

/**
 * The window plan with held rows kept in the tail (`holdPinnedTail`). Where the last render's tail began
 * is kept by message id, so older pages landing in front do not move it.
 */
const useHeldTailPlan = (plan: WindowPlan, messages: ReadonlyArray<UIMessage>, pinned: ReadonlyArray<number>): WindowPlan => {
    const [tailStartId, setTailStartId] = useState<string | undefined>(undefined);
    const previousTailStart = tailStartId === undefined ? -1 : messages.findIndex((message) => message.id === tailStartId);
    const held = holdPinnedTail(plan, previousTailStart, pinned);
    const nextTailStartId = messages[held.virtualized ? held.headCount : 0]?.id;

    if (nextTailStartId !== tailStartId) {
        setTailStartId(nextTailStartId);
    }

    return held;
};

/**
 * The row that holds focus, by message id: anything focused in a row (an input, a button) keeps that row
 * mounted, so typing into or tabbing through a row never has it virtualized away underneath.
 */
const useFocusedRowId = (listRef: RefObject<HTMLElement | null>): string | undefined => {
    const [focusedId, setFocusedId] = useState<string | undefined>(undefined);

    useEffect(() => {
        const list = listRef.current;

        if (!list) {
            return undefined;
        }

        const rowIdOf = (target: EventTarget | null): string | undefined =>
            target instanceof Element && list.contains(target) ? target.closest<HTMLElement>(ROW_SELECTOR)?.dataset.listMessageId : undefined;
        const handleFocusIn = (event: FocusEvent) => setFocusedId(rowIdOf(event.target));
        const handleFocusOut = (event: FocusEvent) => setFocusedId(rowIdOf(event.relatedTarget));

        list.addEventListener("focusin", handleFocusIn);
        list.addEventListener("focusout", handleFocusOut);

        return () => {
            list.removeEventListener("focusin", handleFocusIn);
            list.removeEventListener("focusout", handleFocusOut);
        };
    }, [listRef]);

    return focusedId;
};

/** Every message whose row is held: pinned from inside (`row-pins.ts`), being edited, or holding focus. */
const useHeldRowIds = (pinnedRowIds: ReadonlySet<string>, editingMessageId: string | null, focusedRowId: string | undefined): ReadonlySet<string> =>
    useMemo(() => {
        if (editingMessageId === null && focusedRowId === undefined) {
            return pinnedRowIds;
        }

        const held = new Set(pinnedRowIds);

        if (editingMessageId !== null) {
            held.add(editingMessageId);
        }

        if (focusedRowId !== undefined) {
            held.add(focusedRowId);
        }

        return held;
    }, [editingMessageId, focusedRowId, pinnedRowIds]);

type RenderRow = (message: UIMessage, index: number) => ReactNode;

interface VirtualizedHeadProps {
    /** Changes whenever content above the list may have moved (e.g. the load-more spinner). */
    layoutKey: string;
    messages: UIMessage[];
    /** Every row mounted ("Show all earlier messages", a browser find): the same rows under the same parent, none remounted. */
    mountAll: boolean;
    onVirtualizer: (virtualizer: Virtualizer<HTMLElement, Element> | null) => void;
    /** Rows held mounted wherever the scroll is: a text selection's, an open diff comment's (`pinnedIndexes`). */
    pinned: ReadonlyArray<number>;
    renderRow: RenderRow;
}

/**
 * The older part of a long thread. Rows are absolutely positioned inside a
 * spacer sized to the virtualizer's total, measured as they mount (heights vary
 * a lot). Scrolls with ThreadViewport's element, offset by `scrollMargin`.
 */
const VirtualizedHead: FC<VirtualizedHeadProps> = ({ layoutKey, messages, mountAll, onVirtualizer, pinned, renderRow }) => {
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

    const rangeExtractor = useCallback(
        (range: Parameters<typeof defaultRangeExtractor>[0]) =>
            mountAll ? Array.from({ length: messages.length }, (_, index) => index) : withPinnedRows(defaultRangeExtractor(range), pinned, messages.length),
        [messages.length, mountAll, pinned],
    );

    const virtualizer = useVirtualizer<HTMLElement, Element>({
        count: messages.length,
        estimateSize,
        getItemKey,
        getScrollElement,
        overscan: 4,
        rangeExtractor,
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

    // Read aloud outlives its row (virtualization unmounts it); it ends with the thread, or with its message.
    const messageIds = useMemo(() => threadMessages.map((message) => message.id), [threadMessages]);

    useEndReadAloudWithMessages(messageIds);

    // The server snapshot is the default (on): localStorage does not exist during SSR.
    const isVirtualizeFlagOn = useSyncExternalStore(subscribeToNothing, readVirtualizeFlag, () => true);

    const { isAllShown, showAll } = useShowAllMessages();
    const listRef = useRef<HTMLDivElement>(null);
    const selectedRows = useSelectedRows(listRef);
    const focusedRowId = useFocusedRowId(listRef);
    const heldRowIds = useHeldRowIds(usePinnedRowIds(), editingMessageId, focusedRowId);
    const pinned = useStableIndexes(pinnedIndexes(messages, selectedRows, heldRowIds));
    // "Show all" keeps the same split and mounts the whole head (`mountAll`), so no row changes parent and remounts.
    const plan: WindowPlan = useHeldTailPlan(getWindowPlan(messages.length, { enabled: isVirtualizeFlagOn }), messages, pinned);

    // After "Show all earlier messages", focus goes to the oldest loaded message, where the shown history starts.
    const focusOldestRef = useRef(false);

    useEffect(() => {
        if (!focusOldestRef.current || !isAllShown) {
            return;
        }

        focusOldestRef.current = false;
        document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(messages[0]?.id ?? "")}"]`)?.focus();
    });

    const handleShowAll = useCallback(() => {
        focusOldestRef.current = true;
        showAll();
    }, [showAll]);

    // Jump-to-message. Refs hold the latest plan/messages so the listener is attached once.
    const virtualizerRef = useRef<Virtualizer<HTMLElement, Element> | null>(null);
    const jumpStateRef = useRef({ messages, plan, threadId });

    useLayoutEffect(() => {
        jumpStateRef.current = { messages, plan, threadId };
    });

    const handleVirtualizer = useCallback((virtualizer: Virtualizer<HTMLElement, Element> | null) => {
        virtualizerRef.current = virtualizer;
    }, []);

    // Each jump's generation: a newer jump, or unmounting, retires an older one's pending reveal so it cannot take focus later.
    const jumpGenerationRef = useRef(0);

    useEffect(
        () => () => {
            jumpGenerationRef.current += 1;
        },
        [],
    );

    const jumpTo = useCallback((requestedId: string, position?: MessagePosition, focus = true): boolean => {
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

        jumpGenerationRef.current += 1;
        const generation = jumpGenerationRef.current;

        // Whether the row was in the DOM to reveal.
        const reveal = (): boolean => {
            const element = document.querySelector<HTMLElement>(`[data-list-message-id="${CSS.escape(messageId)}"]`);

            if (!element) {
                return false;
            }

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

            return true;
        };

        if (target.kind === "head" && virtualizerRef.current) {
            // Mount the row first, then reveal it once it has; under load the virtualizer can take several frames to settle.
            virtualizerRef.current.scrollToIndex(target.index, { align: "center" });

            let framesLeft = HEAD_REVEAL_FRAMES;
            const revealWhenMounted = () => {
                if (jumpGenerationRef.current !== generation) {
                    return;
                }

                framesLeft -= 1;

                if (!reveal() && framesLeft > 0) {
                    requestAnimationFrame(revealWhenMounted);
                }
            };

            requestAnimationFrame(() => requestAnimationFrame(revealWhenMounted));
        } else {
            reveal();
        }

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
        // A request retires the reveal an earlier jump still has pending, even before its own target loads.
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
                pendingJumpRef.current = undefined;

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
                <RowMessageIdContext value={message.id}>
                    {goal && threadId && goal.startMessageId === message.id && <GoalBanner goal={goal} maxWidth={maxWidth} threadId={threadId} />}
                    {renderMessage(message, index)}
                    {reviewNotes.get(message.id)?.map((reason, noteIndex) => (
                        <GoalReviewNote key={`${message.id}-review-${String(noteIndex)}`} maxWidth={maxWidth} reason={reason} />
                    ))}
                    {goal &&
                        verdictAnchors
                            ?.get(message.id)
                            ?.map((verdict) => <GoalVerdictNote goal={goal} key={verdict.round} maxWidth={maxWidth} verdict={verdict} />)}
                </RowMessageIdContext>
            </div>
        );
    };

    const tailStart = plan.virtualized ? plan.headCount : 0;
    const earlierCount = plan.headCount;
    // Inside `t`: a bare `plural()` compiles to the global i18n, which this app never activates.
    // eslint-disable-next-line no-restricted-syntax -- the macro compiles this to a message, not a string conversion
    const showAllLabel = t`${plural(earlierCount, { one: "Show # earlier message", other: "Show all # earlier messages" })}`;

    return (
        <>
            {/* Loading indicator — trigger lives in ThreadViewport's scroll handler */}
            <LoadMoreTrigger status={messagesStatus} />

            {/* Rows outside the window are not in the DOM, so Tab, a screen reader and menu-opened find would skip them. Shown on focus. */}
            {plan.virtualized && !isAllShown && (
                <Button className="sr-only mx-auto my-2 focus-visible:not-sr-only" onClick={handleShowAll} size="sm" type="button" variant="outline">
                    {showAllLabel}
                </Button>
            )}

            <div
                className={cn("message-list flex flex-col", className)}
                ref={listRef}
                role="list"
                style={{ "--thread-max-width": maxWidth } as React.CSSProperties}
            >
                {plan.virtualized && (
                    <VirtualizedHead
                        layoutKey={messagesStatus}
                        messages={messages.slice(0, plan.headCount)}
                        mountAll={isAllShown}
                        onVirtualizer={handleVirtualizer}
                        pinned={pinned}
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
