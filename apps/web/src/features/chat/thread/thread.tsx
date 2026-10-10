"use client";

/**
 * Thread v2 - Main chat thread container
 *
 * Provides auto-scrolling, welcome state, message list, and composer.
 *
 * Comparison parent threads use a split-column layout:
 * - Each child thread is displayed in its own scrollable column
 * - A shared composer at the bottom fans the message out to all children
 */

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { ArrowDownIcon } from "lucide-react";
import type { FC } from "react";
import { useEffect, useMemo, useRef } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { useChatActions, useChatIsEmpty, useChatIsStreaming, useChatMessages, useChatThread } from "@/features/chat/core/context/chat-context";
import useComparisonChat from "@/features/chat/core/hooks/use-comparison-chat";
import type { PendingAttachment } from "@/features/chat/core/stores/chat-ui-store";
import { useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import type { ComposerMode } from "@/features/chat/core/stores/model-store";
import { useModelStore } from "@/features/chat/core/stores/model-store";
import ForwardSelectionBar from "@/features/chat/forward/forward-selection-bar";
import { useCRPC } from "@/lib/lunora/crpc";

import ChatError from "./chat-error";
import type { ComparisonBranch } from "./comparison-view";
import ComparisonView from "./comparison-view";
import Composer from "./composer";
import EditComposer from "./edit-composer";
import MediaGalleryView from "./media-gallery-view";
import MessageList from "./message-list";
import TextSelectionMenu from "./text-selection-menu";
import type { ThreadViewportRef } from "./thread-viewport";
import ThreadViewport from "./thread-viewport";
import ThreadWelcome from "./thread-welcome";

interface ThreadProps {
    className?: string;
    initialMessage?: string;
    maxWidth?: string;
}

/**
 * Scroll to bottom button - appears when user scrolls up
 * Uses isAtBottom state from Zustand store.
 */
const ScrollToBottomButton: FC<{ className?: string; onClick: () => void }> = ({ className, onClick }) => {
    const isAtBottom = useChatUIStore((state) => state.isAtBottom);
    const { t } = useLingui();

    if (isAtBottom) {
        return null;
    }

    return (
        <TooltipIconButton
            className={cn("absolute -top-14 rounded-full shadow-md", "bg-background hover:bg-accent border", "transition-all duration-200", className)}
            onClick={onClick}
            tooltip={t`Scroll to bottom`}
            variant="outline"
        >
            <ArrowDownIcon className="size-4" />
        </TooltipIconButton>
    );
};

/**
 * Main Thread component
 * Uses ThreadViewport with custom scroll management.
 */
const Thread: FC<ThreadProps> = ({ className, initialMessage, maxWidth = "65ch" }) => {
    const { t } = useLingui();
    const viewportRef = useRef<ThreadViewportRef>(null);
    const userSettings = useUserSettings();
    const isEmpty = useChatIsEmpty();
    const { activeStreamId, isStreaming } = useChatIsStreaming();
    const { isNewThread, thread, threadId } = useChatThread();

    useChatMessages();
    const { jwtToken } = useChatActions();

    // Detect comparison parent instantly from the already-loaded thread doc (no extra query).
    // Fall back to checking child threads for threads created before the multiChat flag was added.
    const isMultiChatThread = thread?.multiChat === true;

    const crpc = useCRPC();
    const { data: childThreads } = useQuery(
        crpc.chat.functions.getChildThreads.queryOptions(threadId ? { parentThreadId: threadId as Id<"threads"> } : skipToken),
    );

    // Check if this is a comparison parent thread
    const isComparisonThread = useMemo(() => {
        if (isMultiChatThread) {
            return true;
        }

        if (!childThreads || childThreads.length === 0) {
            return false;
        }

        return childThreads.some((child: any) => child.branchType === "comparison");
    }, [isMultiChatThread, childThreads]);

    // Build comparison branches from child threads
    const comparisonBranches = useMemo((): ComparisonBranch[] => {
        if (!isComparisonThread || !childThreads) {
            return [];
        }

        const branches: ComparisonBranch[] = [];

        // The generated output type for getChildThreads loses the thread document fields
        // (they come from a spread validator), so narrow to the fields we read here.
        const children = childThreads as ((typeof childThreads)[number] & { _id: string; model?: string })[];

        for (const child of children) {
            if (child.branchType !== "comparison") {
                continue;
            }

            branches.push({
                activeStreamId: null,
                isLoading: false,
                messages: [],
                model: child.model || "unknown",
                threadId: child._id,
            });
        }

        return branches;
    }, [isComparisonThread, childThreads]);

    // Sync comparison state to model picker when navigating to/from a comparison parent.
    // loadThreadData (in chat-context) clears comparisonMode on every thread switch.
    // This effect re-enables it once getChildThreads resolves and we confirm comparison.
    const setSelectedModelsForComparison = useModelStore((state) => state.setSelectedModelsForComparison);
    const setComparisonMode = useModelStore((state) => state.setComparisonMode);

    useEffect(() => {
        if (!(isComparisonThread && comparisonBranches.length > 0)) {
            return;
        }

        const models = comparisonBranches.map((b) => b.model);

        setSelectedModelsForComparison(models);
        setComparisonMode(true);
    }, [isComparisonThread, comparisonBranches, setSelectedModelsForComparison, setComparisonMode]);

    // Comparison hook for fan-out sends on the parent thread
    const { sendToExistingChildren } = useComparisonChat({ jwtToken });

    // Submit handler for the comparison parent composer: fans message to all children
    const handleComparisonParentSubmit = async (text: string, attachments: PendingAttachment[]) => {
        const children = comparisonBranches.map((b) => {
            return { model: b.model, threadId: b.threadId };
        });

        await sendToExistingChildren(text, children, attachments);
    };

    // Get mode from thread data (source of truth) or store (for new threads or user changes)
    const storeNewThreadMode = useModelStore((state) => state.newThreadMode);
    const storeUserChangedMode = useModelStore((state) => state.userChangedMode && state.currentModeThreadId === threadId);
    const storeThreadMode = useModelStore((state) => state.threadModes.get(threadId || ""));

    const resolveComposerMode = (): ComposerMode => {
        if (isNewThread || !threadId) {
            return storeNewThreadMode;
        }

        // If user explicitly changed mode for this thread, use store value
        if (storeUserChangedMode) {
            return storeThreadMode || "text";
        }

        // Otherwise use thread's persisted mode, fallback to "text" if still loading
        // This prevents loading states and allows instant render with sensible default
        return (thread?.mode as ComposerMode) || "text";
    };

    const composerMode = resolveComposerMode();

    // ─── Comparison parent layout ─────────────────────────────────────────────
    // Each child thread is shown in a scrollable column; a shared composer
    // at the bottom fans the same message to all children simultaneously.
    // Render immediately when isMultiChatThread is true (instant from thread doc),
    // even while childThreads is still loading (branches will be populated soon).
    if (isComparisonThread) {
        const modelCount = comparisonBranches.length;
        const comparisonPlaceholder =
            modelCount > 0 ? t`${plural(modelCount, { one: "Ask # model anything...", other: "Ask # models anything..." })}` : t`Ask all models anything...`;

        return (
            <>
                <TextSelectionMenu isTextModel={composerMode === "text"} threadId={threadId} />
                <div className={cn("relative flex h-[calc(100%-40px)]", className)}>
                    {/* Columns — each scrolls independently, divided by borders */}
                    <ComparisonView branches={comparisonBranches} className="min-h-0 flex-1" />

                    {/* Shared composer — syncs input to all child threads */}
                    <div className="absolute right-0 bottom-0 left-0 mx-auto flex shrink-0 flex-col items-center rounded-t-lg bg-inherit px-4 pt-3 pb-4">
                        <ChatError className="mb-3 w-full max-w-3xl" />
                        <Composer
                            className="w-full max-w-3xl"
                            key={threadId}
                            minimal
                            onSubmitOverride={handleComparisonParentSubmit}
                            placeholder={comparisonPlaceholder}
                        />
                    </div>
                </div>
            </>
        );
    }

    const isEnableFollowupSuggestions = userSettings?.data?.enableFollowupSuggestions !== false;

    // Show message list when we have messages OR when streaming is active.
    // isStreaming covers the brief transition after activeStreamId clears.
    const showMessageList = !isEmpty || isStreaming;

    const handleScrollToBottom = () => {
        viewportRef.current?.scrollToBottom();
    };

    // ─── Normal thread layout ─────────────────────────────────────────────────
    return (
        <>
            <TextSelectionMenu isTextModel={composerMode === "text"} threadId={threadId} />
            <div className={cn("h-[calc(100%-40px)]", className)} style={{ "--thread-max-width": maxWidth } as React.CSSProperties}>
                <ThreadViewport className="flex h-full flex-col items-center bg-inherit px-4 pt-2" ref={viewportRef}>
                    <div
                        className={clsx("assistant-message flex min-h-full w-full flex-col", {
                            "prose prose-slate dark:prose-invert max-w-(--thread-max-width)": composerMode === "text",
                        })}
                    >
                        {composerMode !== "text" && (
                            <div className="flex w-full flex-1 flex-col">
                                <MediaGalleryView className="flex-1 pb-6" maxWidth={maxWidth} />
                            </div>
                        )}
                        {composerMode === "text" && showMessageList && (
                            <div className="flex w-full flex-1 flex-col">
                                <MessageList
                                    className={isEnableFollowupSuggestions && !activeStreamId ? "pb-[190px]" : "pb-6"}
                                    editComposerComponent={EditComposer}
                                    maxWidth={maxWidth}
                                />
                                <div className="flex-1" />
                            </div>
                        )}
                        {composerMode === "text" && !showMessageList && (
                            <div className="flex flex-1 flex-col items-center justify-center">
                                <ThreadWelcome />
                            </div>
                        )}

                        {/* Footer with composer */}
                        <div className="sticky bottom-0 mx-auto flex w-full max-w-(--thread-max-width) flex-col items-center justify-end rounded-t-lg bg-inherit">
                            <ScrollToBottomButton className="z-10" onClick={handleScrollToBottom} />
                            {/* Error display */}
                            <ChatError className="mb-3 w-full" />
                            <ForwardSelectionBar threadId={threadId} />
                            {/* Full-featured composer with model selector, language selector, slash commands */}
                            {/* Key by threadId to reset state when switching threads */}
                            <Composer className="w-full" initialMessage={initialMessage} key={threadId} />
                        </div>
                    </div>
                </ThreadViewport>
            </div>
        </>
    );
};

Thread.displayName = "Thread";

export default Thread;
