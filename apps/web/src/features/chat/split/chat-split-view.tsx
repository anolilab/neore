"use client";

import { useLingui } from "@lingui/react/macro";
import { isLunoraId } from "@neore/client-runtime";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@neore/ui/components/resizable";
import cn from "@neore/ui/utils/cn";
import { CrosshairIcon, XIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { ChatProvider, useChatThread } from "@/features/chat/core/context/chat-context";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import ChatSiteHeader from "@/features/chat/header/chat-header";
import { LockedChatGate } from "@/features/chat/lock/locked-chat-gate";
import { useThreadShard } from "@/features/chat/sharing/use-thread-shard";
import ThreadSidebar from "@/features/chat/sidebar/thread-sidebar";
import Thread from "@/features/chat/thread/thread";
import { useThreadPaneState } from "@/features/chat/thread/use-thread-pane-state";

import { saveComposerDraft, setSplitViewMounted, takeComposerDraftState } from "./composer-drafts";
import { MIN_PANE_PX } from "./split-layout";
import { hydrateSplitLayout, useSplitLayoutStore } from "./split-layout-store";
import { useChatHasDraft } from "./use-chat-has-draft";

/** Below this the split is off and one chat shows (the app's `md` breakpoint). */
const DESKTOP_QUERY = "(min-width: 768px)";
/** The space between two panes: the resize handle itself, so there is no line between them. */
const GAP_PX = 8;
/** How many frames to wait for the composer's editor (it loads lazily) before giving up on moving focus into it. */
const FOCUS_FRAMES = 60;

const subscribeDesktop = (notify: () => void): (() => void) => {
    const media = globalThis.matchMedia(DESKTOP_QUERY);

    media.addEventListener("change", notify);

    return () => media.removeEventListener("change", notify);
};

const useIsDesktop = (): boolean =>
    useSyncExternalStore(
        subscribeDesktop,
        () => globalThis.matchMedia(DESKTOP_QUERY).matches,
        () => true,
    );

/**
 * Makes the focused pane's chat the one the global model state describes. Every pane's provider loads its chat's model into
 * that one store when it mounts or its chat loads, so after a background chat loads, the composer of the focused one would
 * otherwise show the wrong model.
 */
const FocusModelSync: FC<{ isFocused: boolean }> = ({ isFocused }) => {
    const { thread, threadId } = useChatThread();
    const selectedModelThreadId = useModelStore((state) => state.selectedModelThreadId);
    const model = thread?.activeAgent?.model ?? thread?.model;
    const mode = thread?.mode;
    const isLoaded = thread !== null && thread !== undefined;

    useEffect(() => {
        if (!(isFocused && threadId && isLoaded)) {
            return;
        }

        const state = useModelStore.getState();
        const userChanged =
            (state.userChangedModel && state.selectedModelThreadId === threadId) || (state.userChangedMode && state.currentModeThreadId === threadId);

        if (!userChanged) {
            state.loadThreadData({ mode, model }, threadId);
        }
    }, [isFocused, isLoaded, mode, model, selectedModelThreadId, threadId]);

    return null;
};

/**
 * The `#abcd` that tells two panes with the same title apart, or undefined. Reads the titles itself with a selector that answers
 * a string, so a pane re-renders only when its own suffix changes, not for every title change in the layout.
 */
const usePaneSuffix = (threadId: string, paneIds: ReadonlyArray<string>): string | undefined =>
    useSplitLayoutStore((state) => {
        const title = state.titles[threadId];
        const isAmbiguous = title !== undefined && paneIds.some((id) => id !== threadId && state.titles[id] === title);

        return isAmbiguous ? `#${threadId.slice(-4)}` : undefined;
    });

interface PaneProps {
    canClose: boolean;
    /** Where the focused pane's header goes; the page's header slot. */
    headerSlot: HTMLElement | null;
    initialMessage?: string;
    initialThread?: Parameters<typeof ChatProvider>[0]["initialThread"];
    isFocused: boolean;
    isRouteThread: boolean;
    jwtToken: string;
    onClose: () => void;
    onFocus: () => void;
    /** The chat does not exist (deleted elsewhere): the pane has nothing to show. */
    onMissing: () => void;
    /** Every pane's chat, to tell which other pane has the same title. */
    paneIds: ReadonlyArray<string>;
    /** The right-hand panel: the focused pane renders its chat's details into it, under its own gate and provider. */
    sidebarSlot: HTMLElement | null;
    threadId: string;
}

/**
 * One chat in the split view: a card with a header and the thread. Its provider stays mounted whether or not the pane has
 * focus, so a reply that is streaming into a background pane keeps streaming.
 */
const Pane: FC<PaneProps> = ({
    canClose,
    initialMessage,
    initialThread,
    headerSlot,
    isFocused,
    isRouteThread,
    jwtToken,
    onClose,
    onFocus,
    onMissing,
    paneIds,
    sidebarSlot,
    threadId,
}) => {
    const { t } = useLingui();
    const headingId = useId();
    const setTitle = useSplitLayoutStore((state) => state.setTitle);
    const paneRef = useRef<HTMLElement>(null);
    // Set when the stub handed focus over: the composer is not there yet, so the focus follows once it is.
    const focusComposerRef = useRef(false);
    // A chat shared with the person lives on its owner's shard, and the page only settled the one in the URL.
    const shardReady = useThreadShard(threadId);
    // Read only once the shard is settled: before that a chat on another shard answers not-found, and the provider reads the same key.
    const { data: paneState } = useThreadPaneState(threadId, { enabled: shardReady });
    const title = paneState?.title ?? t`Chat`;
    const hasDraft = useChatHasDraft(threadId);
    const suffix = usePaneSuffix(threadId, paneIds);
    // The chat in the URL is the page's own: it is never closed from here, whatever a read says for a moment.
    const isMissing = paneState === null && !isRouteThread;

    useEffect(() => {
        setTitle(threadId, title);
    }, [setTitle, threadId, title]);

    useEffect(() => {
        if (isMissing) {
            onMissing();
        }
    }, [isMissing, onMissing]);

    useEffect(() => {
        if (!(isFocused && focusComposerRef.current)) {
            return undefined;
        }

        let frame = 0;
        let frames = 0;
        const focusEditor = () => {
            const editor = paneRef.current?.querySelector<HTMLElement>('[role="textbox"]');

            if (editor) {
                editor.focus();
                focusComposerRef.current = false;

                return;
            }

            frames += 1;

            if (frames < FOCUS_FRAMES) {
                frame = requestAnimationFrame(focusEditor);
            }
        };

        focusEditor();

        return () => cancelAnimationFrame(frame);
    }, [isFocused]);

    const activate = () => {
        focusComposerRef.current = true;
        onFocus();
    };

    // The header's button is the short way from the top of a pane to its composer: Tab from here would pass every message first.
    const focusComposer = () => {
        if (!isFocused) {
            activate();

            return;
        }

        paneRef.current?.querySelector<HTMLElement>('[role="textbox"]')?.focus();
    };

    return (
        <section
            aria-labelledby={headingId}
            className={cn(
                "border-border bg-card flex h-full min-w-0 flex-col overflow-hidden rounded-[14px] border outline-2 -outline-offset-2",
                isFocused ? "outline-ring/40" : "outline-transparent",
            )}
            data-focused={isFocused ? "" : undefined}
            data-pane-thread-id={threadId}
            ref={paneRef}
        >
            {/* Brighter when focused, in either theme: --muted is darker than --card in light and lighter in dark. */}
            <header
                className={cn(
                    "flex h-9 shrink-0 items-center gap-1 px-3",
                    isFocused ? "text-foreground dark:bg-muted" : "bg-muted/60 text-muted-foreground dark:bg-transparent",
                )}
            >
                {hasDraft && <span aria-hidden="true" className="border-muted-foreground size-2 shrink-0 rounded-full border-[1.5px] border-dashed" />}
                <h2 className="min-w-0 flex-1 truncate text-sm font-medium" id={headingId}>
                    {title}
                    {suffix && <span className="ml-1 font-normal opacity-70">{suffix}</span>}
                    {hasDraft && <span className="sr-only">{t`Unsent draft`}</span>}
                </h2>
                <TooltipIconButton
                    aria-pressed={isFocused}
                    className="transition-none"
                    data-pane-focus=""
                    onClick={focusComposer}
                    tooltip={t`Focus chat: ${title}`}
                >
                    <CrosshairIcon aria-hidden="true" className="size-4" />
                </TooltipIconButton>
                {canClose && (
                    <TooltipIconButton className="transition-none" onClick={onClose} tooltip={t`Close pane: ${title}`}>
                        <XIcon aria-hidden="true" className="size-4" />
                    </TooltipIconButton>
                )}
            </header>
            <div className="relative min-h-0 flex-1">
                {shardReady && (
                    <LockedChatGate threadId={threadId}>
                        <ChatProvider initialThread={initialThread} jwtToken={jwtToken} threadId={threadId}>
                            <FocusModelSync isFocused={isFocused} />
                            {isFocused && headerSlot && createPortal(<ChatSiteHeader threadId={threadId} />, headerSlot)}
                            {isFocused && sidebarSlot && createPortal(<ThreadSidebar threadId={threadId} />, sidebarSlot)}
                            <Thread className="h-full" composerActive={isFocused} initialMessage={initialMessage} onActivateComposer={activate} splitPane />
                        </ChatProvider>
                    </LockedChatGate>
                )}
            </div>
        </section>
    );
};

/** A panel with the keyboard-operable divider to its left. The divider is the gap: it has no line. */
const PaneSlot: FC<{ children: React.ReactNode; index: number; label: string; threadId: string }> = ({ children, index, label, threadId }) => (
    <>
        {index > 0 && (
            <ResizableHandle
                aria-label={label}
                className="hover:bg-border/60 focus-visible:bg-border/60 focus-visible:ring-ring bg-transparent focus-visible:ring-2 focus-visible:ring-offset-0 aria-[orientation=vertical]:w-2"
            />
        )}
        <ResizablePanel id={threadId} minSize={MIN_PANE_PX}>
            {children}
        </ResizablePanel>
    </>
);

interface ChatSplitViewProps {
    /** Where the focused pane's header goes; the page's header wrapper. Without one no header shows. */
    headerSlot?: HTMLElement | null;
    /** The route's `initialMessage`, for the chat in the URL only. */
    initialMessage?: string;
    initialThread?: PaneProps["initialThread"];
    jwtToken: string;
    /** The chat in the URL. It is shown (focused, or in place of the focused pane) whenever it changes. Absent on `/chat`. */
    routeThreadId?: string;
    /** Where the right-hand panel goes; the page's panel wrapper. */
    sidebarSlot: HTMLElement | null;
}

/**
 * Up to three chats side by side. The URL names one chat and stays put while focus moves between panes, so everything a pane
 * does is keyed on the pane's own thread id, never on the route. Below 768px the split is off: the focused chat shows alone.
 */
const ChatSplitView: FC<ChatSplitViewProps> = ({ headerSlot = null, initialMessage, initialThread, jwtToken, routeThreadId, sidebarSlot }) => {
    const { t } = useLingui();
    const layout = useSplitLayoutStore((state) => state.layout);
    const dispatch = useSplitLayoutStore((state) => state.dispatch);
    const isDesktop = useIsDesktop();
    const [ready, setReady] = useState(false);
    const lastRouteThreadId = useRef(routeThreadId);
    const containerRef = useRef<HTMLDivElement>(null);
    // The chat of a pane the person just closed: focus then moves to a surviving pane instead of being lost with the button.
    const closedPaneRef = useRef<{ index: number; threadId: string } | null>(null);

    useEffect(() => {
        setSplitViewMounted(true);

        return () => setSplitViewMounted(false);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const start = async () => {
            await hydrateSplitLayout();

            if (cancelled) {
                return;
            }

            dispatch({ isValid: (id) => isLunoraId(id), type: "prune" });

            if (routeThreadId !== undefined) {
                dispatch({ threadId: routeThreadId, type: "show" });
            }

            setReady(true);
        };

        void start();

        return () => {
            cancelled = true;
        };
        // Once: later changes of the route are handled below, after the saved layout is in.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (!ready || lastRouteThreadId.current === routeThreadId) {
            return;
        }

        lastRouteThreadId.current = routeThreadId;

        if (routeThreadId !== undefined) {
            dispatch({ threadId: routeThreadId, type: "show" });
        }
    }, [dispatch, ready, routeThreadId]);

    const focusedThreadId = layout.panes[layout.focus];

    // The composer's draft (text, attachments, references) is one global value: park the outgoing pane's and bring back the
    // incoming one's. Runs after the new composer has mounted, so nothing the mount does overwrites the restored text.
    const previousFocused = useRef<string | undefined>(undefined);

    useEffect(() => {
        if (!ready) {
            return;
        }

        const previous = previousFocused.current;

        previousFocused.current = focusedThreadId;

        if (previous === undefined || focusedThreadId === undefined || previous === focusedThreadId) {
            return;
        }

        const ui = useChatUIStore.getState();

        saveComposerDraft(previous, {
            attachedReferences: ui.attachedReferences,
            composerAttachments: ui.composerAttachments,
            composerText: ui.composerText,
        });
        // `restoreComposer` leaves a composer that has content alone, so the outgoing one is cleared first.
        ui.clearComposer();
        ui.restoreComposer(takeComposerDraftState(focusedThreadId));
    }, [focusedThreadId, ready]);

    useEffect(() => {
        const closed = closedPaneRef.current;

        if (!closed || layout.panes.includes(closed.threadId)) {
            return undefined;
        }

        closedPaneRef.current = null;

        // The pane that took the closed one's place, or the one before it, is its neighbour; otherwise the first.
        const isNeighbour = layout.focus === closed.index || layout.focus === closed.index - 1;
        const target = isNeighbour ? layout.panes[layout.focus] : layout.panes[0];
        const frame = requestAnimationFrame(() => {
            const panes = containerRef.current?.querySelectorAll<HTMLElement>("[data-pane-thread-id]") ?? [];
            const pane = [...panes].find((node) => node.dataset.paneThreadId === target) ?? panes[0];

            pane?.querySelector<HTMLElement>("[data-pane-focus]")?.focus();
        });

        return () => cancelAnimationFrame(frame);
    }, [layout.focus, layout.panes]);

    if (!ready || layout.panes.length === 0) {
        return <div className="h-full" />;
    }

    const closeThread = (threadId: string) => {
        const index = useSplitLayoutStore.getState().layout.panes.indexOf(threadId);

        if (index !== -1) {
            dispatch({ index, type: "close" });
        }
    };
    const renderPane = (threadId: string, index: number) => (
        <Pane
            canClose={layout.panes.length > 1}
            headerSlot={headerSlot}
            initialMessage={threadId === routeThreadId ? initialMessage : undefined}
            initialThread={threadId === routeThreadId ? initialThread : undefined}
            isFocused={index === layout.focus}
            isRouteThread={threadId === routeThreadId}
            jwtToken={jwtToken}
            key={threadId}
            onClose={() => {
                closedPaneRef.current = { index, threadId };
                dispatch({ index, type: "close" });
            }}
            onFocus={() => dispatch({ index, type: "focus" })}
            onMissing={() => closeThread(threadId)}
            paneIds={layout.panes}
            sidebarSlot={sidebarSlot}
            threadId={threadId}
        />
    );

    if (!isDesktop) {
        const focusedPane = layout.panes[layout.focus] as string;

        return (
            <div className="h-full min-h-0 p-2 pt-0" data-split-view="" ref={containerRef}>
                {renderPane(focusedPane, layout.focus)}
            </div>
        );
    }

    const hasSizes = layout.panes.every((id) => layout.sizes[id] !== undefined);
    const minWidth = layout.panes.length * MIN_PANE_PX + (layout.panes.length - 1) * GAP_PX;

    return (
        <div className="h-full min-h-0 overflow-x-auto p-2 pt-0" data-split-view="" ref={containerRef}>
            <ResizablePanelGroup
                className="h-full"
                defaultLayout={hasSizes ? layout.sizes : undefined}
                onLayoutChanged={(sizes) => dispatch({ sizes, type: "resize" })}
                style={{ minWidth }}
            >
                {layout.panes.map((threadId, index) => (
                    <PaneSlot index={index} key={threadId} label={t`Resize chats`} threadId={threadId}>
                        {renderPane(threadId, index)}
                    </PaneSlot>
                ))}
            </ResizablePanelGroup>
        </div>
    );
};

export default ChatSplitView;
