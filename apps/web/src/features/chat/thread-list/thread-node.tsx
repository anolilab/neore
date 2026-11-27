import type { useSortable } from "@dnd-kit/sortable";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { forgetUnlockProof, LUNORA_ID_SOURCE, useUnlockProof } from "@neore/client-runtime";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import Discord from "@neore/ui/icons/discord";
import Line from "@neore/ui/icons/line";
import Slack from "@neore/ui/icons/slack";
import Telegram from "@neore/ui/icons/telegram";
import WeChat from "@neore/ui/icons/wechat";
import WhatsApp from "@neore/ui/icons/whatsapp";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useRouter } from "@tanstack/react-router";
import {
    AlarmClock,
    ArchiveIcon,
    ChevronDown,
    ChevronRight,
    CircleStop,
    DownloadIcon,
    ExternalLink,
    Folder,
    GitBranch,
    GitCompareArrows,
    GitPullRequestArrow,
    GripVertical,
    HourglassIcon,
    Laptop,
    Loader2,
    Lock,
    Pin,
    PinOff,
    Send,
    Tag,
    TrashIcon,
    Users,
} from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import { DEFAULT_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { usePromptQueueStore } from "@/features/chat/core/stores/prompt-queue-store";
import type { ThreadLockMode } from "@/features/chat/lock/thread-lock-dialog";
import { ThreadLockDialog } from "@/features/chat/lock/thread-lock-dialog";
import type { PaneOpenResult } from "@/features/chat/split/split-layout-store";
import { openThreadInSplitView, useSplitLayoutStore } from "@/features/chat/split/split-layout-store";
import { useChatHasDraft } from "@/features/chat/split/use-chat-has-draft";
import { THREAD_CATEGORY_LABELS } from "@/features/chat/tags/thread-categories";
import ThreadTagChips from "@/features/chat/tags/thread-tag-chips";
import { ThreadTagsMenuItems } from "@/features/chat/tags/thread-tags-menu";
import { usePullRequestCount } from "@/features/develop/components/pull-request-counts";
import { focusThreadSearchToggle } from "@/features/keyboard/lib/thread-search-target";
import { useUIStateStore } from "@/features/layout/stores/ui-state-store";
import useCachedModelName from "@/hooks/use-cached-model-name";
import { useHasOpened } from "@/hooks/use-has-opened";
import { LOAD_MARKS, useLoadMarkWhenVisible } from "@/lib/analytics/load-marks";
import { createLunoraQueryOptions, useCRPC, useLunora } from "@/lib/lunora/crpc";
import { openThreadWindow, supportsThreadWindows } from "@/lib/native/bridge";
import { showError, showWarning } from "@/lib/toast";

import { useIsKeyboardSelected } from "./contexts/keyboard-selection-context";
import useCanHover from "./hooks/use-can-hover";
import { useConfirmBeforeDelete } from "./hooks/use-confirm-before-delete";
import useMinuteClock from "./hooks/use-minute-clock";
import { useThreadStateActions } from "./hooks/use-thread-state-actions";
import type { Elapsed } from "./lib/elapsed";
import { describeElapsed } from "./lib/elapsed";
import { releaseBlinkWindow } from "./lib/needs-you-blink";
import { hasUnreadReply, isSnoozed } from "./lib/thread-state-rules";
import MessageSearchMatches from "./message-search-matches";
import SortableThreadItem from "./sortable-thread-item";
import { selectSetShowManageTagsDialog, useThreadListUIStore } from "./stores/thread-list-ui-store";
import { isThreadLocked } from "./thread-lock";
import ThreadOptionsMenu from "./thread-options-menu";
import ThreadStatusIcon, { NEEDS_YOU_TEXT_CLASS } from "./thread-status-icon";
import type { BranchNode, LoadingStates } from "./types";

// Lazy: a dialog opened on demand.
const MoveToProjectDialog = lazy(() => import("@/features/projects/components/move-to-project-dialog"));

/** Colour, icon and display name of the badge for threads that came in through a messenger. */
const MESSENGER_BADGES: Record<string, { className: string; icon: FC<{ className?: string }>; name: string }> = {
    discord: { className: "bg-[#5865F2]/15 text-[#5865F2] dark:bg-[#5865F2]/25 dark:text-[#8b94f7]", icon: Discord, name: "Discord" },
    feishu: { className: "bg-[#3370FF]/15 text-[#3370FF] dark:bg-[#3370FF]/25 dark:text-[#7fa3ff]", icon: Send, name: "Feishu / Lark" },
    line: { className: "bg-[#06C755]/15 text-[#05a648] dark:bg-[#06C755]/25 dark:text-[#5fe08f]", icon: Line, name: "LINE" },
    slack: { className: "bg-[#4A154B]/15 text-[#4A154B] dark:bg-[#4A154B]/25 dark:text-[#c49bc5]", icon: Slack, name: "Slack" },
    teams: { className: "bg-[#5059C9]/15 text-[#5059C9] dark:bg-[#5059C9]/25 dark:text-[#9aa0ec]", icon: Users, name: "Microsoft Teams" },
    telegram: { className: "bg-[#0088cc]/15 text-[#0088cc] dark:bg-[#0088cc]/25 dark:text-[#54b4e8]", icon: Telegram, name: "Telegram" },
    wechat: { className: "bg-[#07C160]/15 text-[#06a152] dark:bg-[#07C160]/25 dark:text-[#5fe09a]", icon: WeChat, name: "WeChat" },
    whatsapp: { className: "bg-[#25D366]/15 text-[#128C7E] dark:bg-[#25D366]/25 dark:text-[#6ee79a]", icon: WhatsApp, name: "WhatsApp" },
};

const messengerSourceName = (source: string): string => MESSENGER_BADGES[source]?.name ?? source.charAt(0).toUpperCase() + source.slice(1);

const renderMessengerBadgeIcon = (source: string) => {
    const Icon = MESSENGER_BADGES[source]?.icon;

    return Icon ? <Icon aria-hidden="true" className="size-3" /> : null;
};

const CHAT_THREAD_PATH_RE = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

/** Child rows take no part in the list's keyboard reset; one function for all of them keeps their props unchanged. */
const ignoreMouseEnter = (): void => {};

/** Escaped Tailwind `group/action-item` class selector, hoisted so the render body stays compilable. */
const ACTION_ITEM_SELECTOR = String.raw`.group\/action-item`;

// Inlined ThreadNodeChildren component (previously separate file)
const getPinTooltip = (isPinning: boolean, isPinned: boolean | undefined): MessageDescriptor => {
    if (isPinning) {
        return msg`Processing...`;
    }

    return isPinned ? msg`Unpin thread` : msg`Pin thread`;
};

const getArchiveTooltip = (isArchiving: boolean, status: string | undefined): MessageDescriptor => {
    if (isArchiving) {
        return msg`Processing...`;
    }

    return status === "archived" ? msg`Unarchive thread` : msg`Archive thread`;
};

const shortDateFormats = new Map<string, Intl.DateTimeFormat>();

/** One formatter per locale for the "older than a week" date, shared by every row instead of built on each render. */
const shortDateFormat = (locale: string): Intl.DateTimeFormat => {
    let format = shortDateFormats.get(locale);

    if (!format) {
        format = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
        shortDateFormats.set(locale, format);
    }

    return format;
};

const ThreadNodeChildren: FC<{
    expandedThreads: Set<string>;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handleMouseEnter: () => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    isSelectionMode: boolean;
    loadingStates: LoadingStates;
    nodes: BranchNode[];
    selectedThreadIds: Set<string>;
    toggleExpanded: (threadId: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}> = ({
    expandedThreads,
    handleCreateBranch,
    handleDeleteThread,
    handleDownloadThread,
    handleMouseEnter,
    handlePinThread,
    handleThreadToggle,
    handleUnpinThread,
    isSelectionMode,
    loadingStates,
    nodes: children,
    selectedThreadIds,
    toggleExpanded,
    updateThread,
}) => (
    <div className="relative">
        {children.map((child, childIndex) => (
            <SortableThreadItem
                expandedThreads={expandedThreads}
                handleCreateBranch={handleCreateBranch}
                handleDeleteThread={handleDeleteThread}
                handleDownloadThread={handleDownloadThread}
                handleMouseEnter={handleMouseEnter}
                handlePinThread={handlePinThread}
                handleThreadToggle={handleThreadToggle}
                handleUnpinThread={handleUnpinThread}
                index={childIndex}
                isSelected={selectedThreadIds.has(child.threadId)}
                isSelectionMode={isSelectionMode}
                key={child.threadId}
                loadingStates={loadingStates}
                node={child}
                selectedThreadIds={selectedThreadIds}
                toggleExpanded={toggleExpanded}
                updateThread={updateThread}
            />
        ))}
    </div>
);

interface ThreadNodeProperties {
    dragAttributes?: ReturnType<typeof useSortable>["attributes"];
    dragListeners?: ReturnType<typeof useSortable>["listeners"];
    expandedThreads: Set<string>;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    index?: number;
    isSelected: boolean;
    isSelectionMode: boolean;
    loadingStates: LoadingStates;
    node: BranchNode;
    selectedThreadIds: Set<string>;
    toggleExpanded: (threadId: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}

const ThreadNode: FC<ThreadNodeProperties> = ({
    dragAttributes,
    dragListeners,
    expandedThreads,
    handleCreateBranch,
    handleDeleteThread,
    handleDownloadThread,
    handlePinThread,
    handleThreadToggle,
    handleUnpinThread,
    index,
    isSelected,
    isSelectionMode,
    loadingStates,
    node,
    selectedThreadIds,
    toggleExpanded,
    updateThread,
}) => {
    const { i18n, t } = useLingui();
    // One shared tick per minute for every row's relative time.
    const clock = useMinuteClock();
    const crpc = useCRPC();
    const lunoraClient = useLunora();

    // The first row on screen is when the sidebar list became visible (real-user load timing, `lib/analytics/load-marks.ts`);
    // a row mounted in a collapsed sidebar does not count.
    const rowRef = useRef<HTMLDivElement>(null);

    useLoadMarkWhenVisible(LOAD_MARKS.sidebarListVisible, rowRef);
    const router = useRouter();
    // Boolean selectors: a thread switch re-renders the row it leaves and the row it opens, not every row.
    const isActive = useLocation({ select: (location) => location.pathname.match(CHAT_THREAD_PATH_RE)?.[1] === node.threadId });
    const isKeyboardSelected = useIsKeyboardSelected(node.threadId);
    const queryClient = useQueryClient();
    const { mutateAsync: convertToPermanent } = useMutation(crpc.chat.functions.convertTemporaryToPermanent.mutationOptions());
    const { isPending: isStopping, mutate: stopThreadStream } = useMutation(crpc.chat.functions.abortThreadStream.mutationOptions());
    const [isConverting, setIsConverting] = useState(false);
    const [showMoveToProjectDialog, setShowMoveToProjectDialog] = useState(false);
    // Mounted on first open only: rendered closed in every row, the lazy dialog loaded on first paint.
    const hasOpenedMoveToProject = useHasOpened(showMoveToProjectDialog);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const confirmBeforeDelete = useConfirmBeforeDelete();
    const [lockMode, setLockMode] = useState<ThreadLockMode | null>(null);
    // An admin acting as the owner may not lock, archive or delete: the server refuses each, as each withdraws the guest link.
    const isImpersonating = useImpersonating();
    // "Lock now" makes the server refuse the old proof (epoch rotated): forget it here too, and refetch so the locked gate shows at once.
    const { mutate: lockNow } = useMutation(
        crpc.agent.thread_lock.lockThread.mutationOptions({
            onSuccess: async () => {
                forgetUnlockProof(node.threadId);
                await queryClient.invalidateQueries();
            },
        }),
    );
    const isLocked = isThreadLocked(node.lockedAt);
    const unlockProof = useUnlockProof(node.threadId);
    const isUnlocked = isLocked && unlockProof !== undefined;
    // A locked chat shows no title: the list never has one for it.
    const displayTitle = isLocked ? t`Locked chat` : node.title;
    // The row actions repeat for every thread, so each name carries the thread it acts on.
    const named = (action: string) => t`${action}: ${displayTitle}`;
    // Read after mount: the shell exists only in the browser, and the server render must match the first client render.
    const [canOpenWindow, setCanOpenWindow] = useState(false);

    useEffect(() => {
        setCanOpenWindow(supportsThreadWindows());
    }, []);
    const setShowManageTagsDialog = useThreadListUIStore(selectSetShowManageTagsDialog);
    const isOptionsMenuOpen = useThreadListUIStore((state) => state.optionsMenuThreadId === node.threadId);
    const setOptionsMenuThreadId = useThreadListUIStore((state) => state.setOptionsMenuThreadId);
    const setRenameThreadId = useThreadListUIStore((state) => state.setRenameThreadId);
    const setSnoozeThreadId = useThreadListUIStore((state) => state.setSnoozeThreadId);
    // The menu has a copy in the row (screens without hover) and one in the hover strip; only the copy this screen shows may open, so
    // opening it (by click or the context-menu key) never puts two menus on the page.
    const canHover = useCanHover();
    const isTransitioningRef = useRef(false);

    const splitViewEnabled = useUIStateStore((state) => state.preferences.splitViewEnabled === true);
    // A boolean selector, so a row re-renders only when its own chat enters or leaves the panes.
    const isOpenInSplit = useSplitLayoutStore((state) => splitViewEnabled && state.layout.panes.includes(node.threadId));
    // Unsent text only matters where panes park it; with the split view off the single chat is untouched.
    const hasDraft = useChatHasDraft(node.threadId) && splitViewEnabled;
    // On a page with no chat open there is no split view to add a pane to: the chat opens as the page's own, then.
    const handleOpenInSplitView = useCallback(() => {
        const open = async () => {
            let result: PaneOpenResult | undefined;

            try {
                result = await openThreadInSplitView(node.threadId);
            } catch {
                // The saved layout could not be read: the chat opens in the main view below.
                result = undefined;
            }

            if (result === "full") {
                showWarning(t`Split view is full. Close a chat first.`);

                return;
            }

            // Read at the click, not subscribed to: only this handler needs to know whether a chat is open.
            if (result === undefined || !CHAT_THREAD_PATH_RE.test(router.state.location.pathname)) {
                await router.navigate({ params: { threadId: node.threadId }, search: {}, to: "/chat/$threadId" });
            }
        };

        void open();
    }, [node.threadId, router, t]);
    const hasChildren = node?.children?.length > 0;
    const isComparisonParent = hasChildren && node.children?.some((child: any) => child.branchType === "comparison");
    const isExpanded = expandedThreads.has(node.threadId);
    const isRootThread = node?.depth === 0;

    const isPinning = loadingStates.pinning.has(node.threadId);
    const isDeleting = loadingStates.deleting.has(node.threadId);
    const isBranching = loadingStates.branching.has(node.threadId);
    const isDownloading = loadingStates.downloading.has(node.threadId);
    const isArchiving = loadingStates.archiving.has(node.threadId);
    // Check thread status directly from Lunora - "running" means actively streaming, "error" means failed
    const isStreaming = node.status === "running";
    // Owner-only fields: absent on a thread shared with the caller, so none of the states below can show there.
    const linkedPullRequests = usePullRequestCount(node.threadId);
    const needsYou = isStreaming ? undefined : node.awaitingInput;
    const isFailed = node.status === "error" && needsYou === undefined;
    const isUnread = hasUnreadReply(node, { isOpen: isActive, isStreaming });
    const { snoozedUntil } = node;
    // Finished and waiting on nothing (`isIdleThread`): a quiet marker, so nobody sends "continue" just to find out.
    const isIdle = isRootThread && node.isIdle === true && !isStreaming && needsYou === undefined && !isFailed;

    // A thread that no longer waits forgets its blink window, so a later pause may blink again.
    useEffect(() => {
        if (needsYou === undefined) {
            releaseBlinkWindow(node.threadId);
        }
    }, [needsYou, node.threadId]);
    // Read when the snooze menu opens, so render never touches the clock.
    const [snoozeMenuNow, setSnoozeMenuNow] = useState(0);
    const { snooze, unsnooze } = useThreadStateActions();

    // The short form a row's time shows: now, 5m, 2h, 3d, then the date.
    const formatElapsed = (elapsed: Elapsed): string => {
        switch (elapsed.kind) {
            case "date": {
                return shortDateFormat(i18n.locale).format(elapsed.value);
            }
            case "day": {
                const days = elapsed.value;

                return t`${days}d`;
            }
            case "hour": {
                const hours = elapsed.value;

                return t`${hours}h`;
            }
            case "minute": {
                const minutes = elapsed.value;

                return t`${minutes}m`;
            }
            default: {
                return t`now`;
            }
        }
    };

    const formatRemainingTime = useCallback(
        (expiresAt?: number): string | null => {
            if (!expiresAt) {
                return null;
            }

            const now = Date.now();
            const remaining = expiresAt - now;

            if (remaining <= 0) {
                return t`Expired`;
            }

            const hours = Math.floor(remaining / (1000 * 60 * 60));
            const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

            if (hours > 0) {
                return t`${hours}h ${minutes}m`;
            }

            return t`${minutes}m`;
        },
        [t],
    );

    const isTemporary = node.expiresAt !== undefined;
    const sourceName = node.source ? messengerSourceName(node.source) : "";
    const categoryLabel = node.category ? THREAD_CATEGORY_LABELS[node.category] : undefined;
    const remainingTime = isTemporary ? formatRemainingTime(node.expiresAt) : null;

    // Debounced hover handler to prevent excessive prefetching
    const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    const handleMouseEnter = useCallback(() => {
        if (isActive || isSelectionMode) {
            return;
        }

        // Clear any pending hover
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current);
        }

        // Debounce prefetching by 150ms to avoid rapid hover spam
        hoverTimeoutRef.current = setTimeout(() => {
            // Check if thread data is already cached
            // Key derived from the reference. The hand-written literal matched nothing
            // under Lunora, so `isThreadCached` was ALWAYS falsy and every hover
            // re-ran the full prefetch — the debounce's whole purpose defeated.
            const threadCacheKey = crpc.chat.functions.getThread.queryKey({ threadId: node.threadId as Id<"threads"> });
            const isThreadCached = queryClient.getQueryData(threadCacheKey);

            if (isThreadCached) {
                // Data already cached, skip all prefetching
                return;
            }

            // Preload route (for TanStack Router route cache)
            router
                .preloadRoute({
                    params: { threadId: node.threadId },
                    search: { initialMessage: undefined },
                    to: "/chat/$threadId",
                })
                .catch(() => {});

            // Prefetch thread data directly into TanStack Query cache
            void queryClient.prefetchQuery(
                // `node.threadId` is typed `string` on `BranchNode` but always holds a
                // thread document id, so the brand is re-applied at the query boundary.
                createLunoraQueryOptions(lunoraClient, api.chat.functions.getThread, {
                    threadId: node.threadId as Id<"threads">,
                }),
            );

            // Also prefetch messages directly into TanStack Query cache
            void queryClient.prefetchQuery(
                createLunoraQueryOptions(lunoraClient, api.chat.functions.getThreadUIMessages, {
                    paginationOpts: DEFAULT_PAGINATION_OPTS,
                    threadId: node.threadId as Id<"threads">,
                }),
            );

            // Prefetch active stream check for resumable streaming
            void queryClient.prefetchQuery(
                createLunoraQueryOptions(lunoraClient, api.chat.streaming.getActiveStreamForThread, {
                    threadId: node.threadId as Id<"threads">,
                }),
            );
        }, 150);
    }, [isActive, isSelectionMode, node.threadId, router, queryClient, lunoraClient, crpc]);

    // Cleanup timeout on unmount
    useEffect(
        () => () => {
            if (hoverTimeoutRef.current) {
                clearTimeout(hoverTimeoutRef.current);
            }
        },
        [],
    );

    const containerClassName = useMemo(
        () =>
            cn(
                "bg-surface-row web:hover:bg-surface-row-hover has-[a:focus-visible]:ring-ring cursor-pointer rounded-xl has-[a:focus-visible]:ring-2",
                isActive && "bg-surface-row-active web:hover:bg-surface-row-active surface-edge bg-(image:--surface-glow)",
                isKeyboardSelected && "ring-ring ring-2",
                isSelectionMode && isSelected && "bg-surface-row-active web:hover:bg-surface-row-active",
                !isRootThread && "ml-4",
                (isDeleting || loadingStates.reordering) && "pointer-events-none opacity-50",
            ),
        [isActive, isKeyboardSelected, isSelectionMode, isSelected, isRootThread, isDeleting, loadingStates.reordering],
    );

    const handleDeleteClick = () => {
        if (confirmBeforeDelete) {
            setShowDeleteDialog(true);

            return;
        }

        // The row leaves at once and takes this menu with it, so focus goes to the search toggle first, which stays. The menu returns
        // focus to its trigger as it closes, so the toggle gets it again once that has happened.
        focusThreadSearchToggle();
        handleDeleteThread(node.threadId);
        globalThis.setTimeout(focusThreadSearchToggle, 0);
    };

    const handleConvertToPermanent = async () => {
        if (isConverting) {
            return;
        }

        setIsConverting(true);

        try {
            await convertToPermanent({ threadId: node.threadId as Id<"threads"> });
        } catch (error) {
            console.error("Failed to convert thread:", error);
        }

        setIsConverting(false);
    };

    // The row's less-used actions, in the options menu. Each keeps the name its own button had. Their dialogs are rendered by the row,
    // not here: the menu's content unmounts when it closes, and a dialog opened from it would go with it.
    const rowMenuItems = (
        <>
            <DropdownMenuItem
                aria-label={named(isBranching ? t`Creating branch...` : t`Create branch`)}
                disabled={isBranching}
                onClick={() => handleCreateBranch(node.threadId)}
            >
                {isBranching ? <Loader2 aria-hidden="true" className="animate-spin" /> : <GitBranch aria-hidden="true" />}
                {isBranching ? t`Creating branch...` : t`Create branch`}
            </DropdownMenuItem>
            <DropdownMenuItem aria-label={named(t`Move to project`)} onClick={() => setShowMoveToProjectDialog(true)}>
                <Folder aria-hidden="true" />
                {t`Move to project`}
            </DropdownMenuItem>
            {canOpenWindow && (
                <DropdownMenuItem
                    aria-label={named(t`Open in new window`)}
                    onClick={() => {
                        void openThreadWindow(node.threadId);
                    }}
                >
                    <ExternalLink aria-hidden="true" />
                    {t`Open in new window`}
                </DropdownMenuItem>
            )}
            {isTemporary ? (
                // Temporary chats expire and are deleted, so a tag would outlive nothing. Shown inert rather than hidden, so the reason is findable.
                <DropdownMenuItem
                    aria-label={named(t`Tags unavailable for temporary chats`)}
                    disabled
                    title={t`Temporary chats expire, so they can't be tagged. Convert it to a permanent chat to add tags.`}
                >
                    <Tag aria-hidden="true" />
                    {t`Tags`}
                </DropdownMenuItem>
            ) : (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger aria-label={t`Tags for ${displayTitle}`}>
                        <Tag aria-hidden="true" />
                        {t`Tags`}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent className="w-52">
                        <ThreadTagsMenuItems
                            onManageTags={() => {
                                setShowManageTagsDialog(true);
                            }}
                            tagIds={node.tagIds}
                            threadId={node.threadId}
                        />
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            {(!isImpersonating || (isLocked && !isUnlocked)) && (
                <DropdownMenuSub>
                    <DropdownMenuSubTrigger aria-label={named(isLocked ? t`Chat lock: locked` : t`Chat lock`)}>
                        <Lock aria-hidden="true" />
                        {t`Chat lock`}
                    </DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                        {isLocked ? (
                            <>
                                {isUnlocked && !isImpersonating && (
                                    <DropdownMenuItem
                                        onClick={() => {
                                            lockNow({ threadId: node.threadId as Id<"threads"> });
                                        }}
                                    >
                                        {t`Lock now`}
                                    </DropdownMenuItem>
                                )}
                                {!isUnlocked && <DropdownMenuItem onClick={() => setLockMode("unlock")}>{t`Unlock chat`}</DropdownMenuItem>}
                                {!isImpersonating && (
                                    <>
                                        <DropdownMenuItem onClick={() => setLockMode("change")}>{t`Change passcode`}</DropdownMenuItem>
                                        <DropdownMenuItem onClick={() => setLockMode("remove")}>{t`Remove passcode`}</DropdownMenuItem>
                                    </>
                                )}
                            </>
                        ) : (
                            !isImpersonating && <DropdownMenuItem onClick={() => setLockMode("set")}>{t`Lock chat`}</DropdownMenuItem>
                        )}
                    </DropdownMenuSubContent>
                </DropdownMenuSub>
            )}
            <DropdownMenuSub>
                <DropdownMenuSubTrigger aria-label={named(isDownloading ? t`Downloading...` : t`Download thread`)} disabled={isDownloading}>
                    {isDownloading ? <Loader2 aria-hidden="true" className="animate-spin" /> : <DownloadIcon aria-hidden="true" />}
                    {isDownloading ? t`Downloading...` : t`Download thread`}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => handleDownloadThread(node, "json")}>JSON</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadThread(node, "txt")}>TXT</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadThread(node, "pdf")}>PDF</DropdownMenuItem>
                </DropdownMenuSubContent>
            </DropdownMenuSub>
            {isTemporary && (
                <DropdownMenuItem
                    aria-label={named(isConverting ? t`Converting...` : t`Convert to permanent`)}
                    disabled={isConverting}
                    onClick={handleConvertToPermanent}
                >
                    {isConverting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <HourglassIcon aria-hidden="true" />}
                    {isConverting ? t`Converting...` : t`Convert to permanent`}
                </DropdownMenuItem>
            )}
            {!isImpersonating && (
                <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                        aria-label={named(isDeleting ? t`Deleting...` : t`Delete thread`)}
                        disabled={isDeleting}
                        onClick={handleDeleteClick}
                        variant="destructive"
                    >
                        {isDeleting ? <Loader2 aria-hidden="true" className="animate-spin" /> : <TrashIcon aria-hidden="true" />}
                        {isDeleting ? t`Deleting...` : t`Delete thread`}
                    </DropdownMenuItem>
                </>
            )}
        </>
    );

    const optionsMenuProps = {
        children: rowMenuItems,
        isHostRun: node.runner === "host",
        isLocked,
        label: displayTitle,
        onOpenChange: (open: boolean) => setOptionsMenuThreadId(open ? node.threadId : null),
        onOpenInSplitView: splitViewEnabled ? handleOpenInSplitView : undefined,
        onRename: () => setRenameThreadId(node.threadId),
        threadId: node.threadId,
    };

    // The latest of the reply, the update and the creation, as the sections sort by (`derived-sections.ts`).
    const lastActiveAt = Math.max(node.lastReplyAt ?? 0, node.updatedAt ?? 0, node.createdAt);
    // Drawn twice, one copy hidden: in the hover-only action strip, and in the row's flow on a touch screen.
    const renderStopButton = (className: string) =>
        isStreaming &&
        !isSelectionMode && (
            <span className={className} role="presentation">
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                aria-label={named(t`Stop generating`)}
                                className="text-muted-foreground hover:text-foreground size-[22px] p-0"
                                disabled={isStopping}
                                onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();

                                    // Same as the composer's stop: queued prompts wait for the user instead of sending on their own.
                                    usePromptQueueStore.getState().setPaused(node.threadId, true);
                                    stopThreadStream(
                                        { threadId: node.threadId as Id<"threads"> },
                                        { onError: () => showError(t`Could not stop the reply. Please try again.`) },
                                    );
                                }}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                            >
                                <CircleStop aria-hidden="true" className="size-3.5" />
                            </Button>
                        }
                    />
                    <TooltipContent>{t`Stop generating`}</TooltipContent>
                </Tooltip>
            </span>
        );
    const timeLabel = formatElapsed(describeElapsed(lastActiveAt, clock));
    const isArchived = node.status === "archived";
    const hasTags = node.tags !== undefined && node.tags.length > 0;
    const hasCategory = node.category !== undefined && node.category !== "" && node.category !== "general";
    const hasMatches = node.relevantMessages !== undefined && node.relevantMessages.length > 0;
    const isHostRun = node.runner === "host";
    // The model stands in when nothing else has anything to say; a locked chat shows nothing about itself.
    const cachedModelName = useCachedModelName(isLocked ? undefined : node.model);
    const modelName = !isLocked && node.model ? (cachedModelName ?? node.model.split("/").pop() ?? node.model) : undefined;
    const hasMeta =
        hasChildren ||
        hasTags ||
        hasCategory ||
        isHostRun ||
        linkedPullRequests > 0 ||
        hasDraft ||
        isIdle ||
        isTemporary ||
        isArchived ||
        !!node.source ||
        hasMatches;
    const showsModelFallback = !hasMeta && modelName !== undefined;
    const hasSecondLine = hasMeta || showsModelFallback;

    const content = (
        <div
            // An outline takes no room, so the row does not shift when the mark comes and goes.
            className={cn(
                "group/action-item relative flex flex-col gap-[3px] overflow-hidden rounded-xl px-3 py-(--density-row-py)",
                hasDraft && "outline-muted-foreground/60 outline-1 -outline-offset-1 outline-dashed",
            )}
            data-draft={hasDraft ? "" : undefined}
            data-split-open={isOpenInSplit ? "" : undefined}
            onClick={(e) => {
                if (isSelectionMode) {
                    return;
                }

                // A press on the reorder handle drags or reorders; it must not also open the thread this row stands for.
                if ((e.target as Element).closest?.("[data-reorder-handle]")) {
                    return;
                }

                e.stopPropagation();

                // A chat that is already a pane takes focus at once. The page's own chat needs this: its row is "active", so the click
                // below would do nothing, and the route never changes for the split view to react to. Cmd/Ctrl-click keeps its meaning.
                if (isOpenInSplit && !e.metaKey && !e.ctrlKey) {
                    useSplitLayoutStore.getState().dispatch({ threadId: node.threadId, type: "show" });
                }

                // The title is a link and navigates by itself.
                if ((e.target as HTMLElement).closest("a")) {
                    return;
                }

                // Prevent navigation when dialogs are open
                if (showDeleteDialog || showMoveToProjectDialog) {
                    return;
                }

                if (isActive) {
                    return;
                }

                if (isTransitioningRef.current) {
                    return;
                }

                isTransitioningRef.current = true;

                router.navigate({
                    params: { threadId: node.threadId },
                    search: {},
                    to: "/chat/$threadId",
                });
                setTimeout(() => {
                    isTransitioningRef.current = false;
                }, 100);
            }}
            // A pointer shortcut: keyboard users reach the title link (and the row's buttons), so the row takes no role.
            role="presentation"
        >
            {!isDeleting && !loadingStates.reordering && !isSelectionMode && (
                <div
                    aria-label={named(t`Reorder`)}
                    // A 24 px tall target at the card's left edge; its icon sits in the card's padding, so the text does not move.
                    className="focus-visible:ring-ring absolute top-1/2 -left-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-sm opacity-0 transition-opacity group-hover/action-item:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:outline-none"
                    data-reorder-handle=""
                    {...dragAttributes}
                    {...dragListeners}
                >
                    <GripVertical className="text-muted-foreground size-3 cursor-grab active:cursor-grabbing" />
                </div>
            )}

            {/* Line 1: what the thread is called and when it last moved. */}
            <div className="flex h-5 min-w-0 items-center gap-1.5">
                {isSelectionMode && (
                    <Checkbox
                        aria-label={named(t`Select`)}
                        checked={isSelected}
                        className="border-foreground/40 data-checked:border-foreground data-checked:bg-foreground"
                        onCheckedChange={() => {
                            // Selection is driven by onClick, which carries the shiftKey needed for range select.
                        }}
                        onClick={(e) => {
                            e.stopPropagation();

                            if (index !== undefined) {
                                handleThreadToggle(node.threadId, index, e.shiftKey);
                            }
                        }}
                    />
                )}

                {loadingStates.reordering && <Loader2 className="text-muted-foreground size-3 animate-spin" />}

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <span className="text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-[13.5px]">
                                {isStreaming && <ThreadStatusIcon status="running" threadId={node.threadId} />}
                                {needsYou !== undefined && <ThreadStatusIcon status={needsYou} threadId={node.threadId} />}
                                {isFailed && <ThreadStatusIcon status="error" threadId={node.threadId} />}
                                {isComparisonParent && <GitCompareArrows aria-label={t`Model comparison`} className="text-muted-foreground size-3 shrink-0" />}
                                {isLocked && <Lock aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
                                {isSelectionMode ? (
                                    <span className={cn("truncate", isUnread && "font-medium")}>{displayTitle}</span>
                                ) : (
                                    // The title is the row's keyboard target: the row itself holds no role, so the link is what Tab reaches.
                                    <Link
                                        className={cn("truncate rounded-sm focus-visible:outline-none", isUnread && "font-medium")}
                                        params={{ threadId: node.threadId }}
                                        search={{}}
                                        to="/chat/$threadId"
                                    >
                                        {displayTitle}
                                    </Link>
                                )}
                                {isOpenInSplit && (
                                    <span
                                        aria-label={t`Open in split view`}
                                        className="bg-muted-foreground/60 inline-block size-1.5 shrink-0 rounded-full"
                                        data-split-marker=""
                                        role="img"
                                    />
                                )}
                            </span>
                        }
                    />
                    <TooltipContent className="max-w-xs" side="right">
                        <p className="break-words">{displayTitle}</p>
                        {isStreaming && <p className="text-muted-foreground mt-1 text-xs">{t`Streaming...`}</p>}
                        {isFailed && <p className="text-destructive mt-1 text-xs">{t`Response failed - try again`}</p>}
                        {needsYou === "approval" && <p className="mt-1 text-xs">{t`Waiting for your approval`}</p>}
                        {needsYou === "question" && <p className="mt-1 text-xs">{t`Waiting for your answer`}</p>}
                    </TooltipContent>
                </Tooltip>

                {/* Always mounted, so a thread that starts waiting is announced to a user whose focus is elsewhere. */}
                <span className="sr-only" role="status">
                    {needsYou === "approval" && t`Waiting for your approval`}
                    {needsYou === "question" && t`Waiting for your answer`}
                </span>

                {/* The time and marks give way to the action strip while the row is hovered, focused or has a menu open. */}
                <span className="flex shrink-0 items-center gap-1.5 group-focus-within/action-item:invisible group-hover/action-item:invisible group-has-[[data-popup-open]]/action-item:invisible [@media(hover:none)]:group-focus-within/action-item:visible [@media(hover:none)]:group-hover/action-item:visible">
                    {needsYou !== undefined && (
                        <span className={cn("text-[11.5px] font-medium", NEEDS_YOU_TEXT_CLASS)}>{needsYou === "approval" ? t`Approval` : t`Question`}</span>
                    )}
                    <time className="text-muted-foreground text-xs tabular-nums" dateTime={new Date(lastActiveAt).toISOString()}>
                        {timeLabel}
                    </time>
                    {isUnread && (
                        <>
                            <span aria-hidden="true" className="bg-foreground size-1.5 shrink-0 rounded-full" />
                            <span className="sr-only">{t`Unread`}</span>
                        </>
                    )}
                </span>

                {/* A touch screen has no hover to reveal the action strip: the options menu shows there by itself, in the row's flow, so it
                    takes room from the title instead of covering it, and the rest of the strip stays hidden. */}
                {/* A reply in flight keeps its stop button in reach on a touch screen too, beside the options menu. */}
                {renderStopButton("hidden [@media(hover:none)]:contents")}
                <ThreadOptionsMenu {...optionsMenuProps} className="hidden [@media(hover:none)]:contents" open={isOptionsMenuOpen && !canHover} />
            </div>

            {/* Line 2: what is attached to it. */}
            {hasSecondLine && (
                <div className="text-muted-foreground flex h-[18px] min-w-0 items-center gap-1.5 text-xs">
                    {hasChildren && (
                        <button
                            aria-expanded={isExpanded}
                            className="hover:text-foreground focus-visible:ring-ring -ml-1 inline-flex h-[18px] shrink-0 items-center gap-1 rounded px-1 focus-visible:ring-2 focus-visible:outline-none"
                            onClick={(e) => {
                                e.stopPropagation();
                                toggleExpanded(node.threadId);
                            }}
                            type="button"
                        >
                            <GitBranch aria-hidden="true" className="size-3" />
                            <Plural one="# branch" other="# branches" value={node.children.length} />
                            {/* The name starts with the visible count (WCAG 2.5.3), then says what the button does to which thread. */}
                            <span className="sr-only">, {named(isExpanded ? t`Collapse branches` : t`Expand branches`)}</span>
                            {isExpanded ? <ChevronDown aria-hidden="true" className="size-3" /> : <ChevronRight aria-hidden="true" className="size-3" />}
                        </button>
                    )}
                    {isHostRun && (
                        <span className="inline-flex shrink-0 items-center gap-1">
                            <Laptop aria-hidden="true" className="size-3" />
                            {t`Runs on your computer`}
                        </span>
                    )}
                    {hasTags && node.tags && <ThreadTagChips tags={node.tags} />}
                    {hasCategory && (
                        <Badge className="h-4 px-1.5 text-[10px] capitalize" variant="secondary">
                            {categoryLabel ? i18n._(categoryLabel) : node.category}
                        </Badge>
                    )}
                    {linkedPullRequests > 0 && (
                        <span aria-label={t`Linked pull requests: ${linkedPullRequests}`} className="inline-flex shrink-0 items-center gap-0.5">
                            <GitPullRequestArrow aria-hidden className="size-3" />
                            {linkedPullRequests}
                        </span>
                    )}
                    {hasDraft && <span className="shrink-0">{t`Draft`}</span>}
                    {isIdle && <span className="shrink-0">{t`Idle`}</span>}
                    {isTemporary && (
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <div className="text-attention flex shrink-0 items-center gap-1">
                                        <HourglassIcon className="size-3 shrink-0" />
                                        {remainingTime && <span>{remainingTime}</span>}
                                    </div>
                                }
                            />
                            <TooltipContent>{remainingTime ? t`Expires in ${remainingTime}` : t`Temporary chat`}</TooltipContent>
                        </Tooltip>
                    )}
                    {isArchived && <ArchiveIcon aria-hidden="true" className="size-3 shrink-0" />}
                    {showsModelFallback && <span className="min-w-0 truncate">{modelName}</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                        {hasMatches && (
                            <span className="bg-primary/10 text-primary-text shrink-0 rounded-full px-1.5 py-0.5 text-xs">
                                <Plural one="# match" other="# matches" value={node.relevantMessages?.length ?? 0} />
                            </span>
                        )}
                        {/* Messenger platform badge */}
                        {node.source && (
                            <Tooltip>
                                <TooltipTrigger
                                    render={
                                        <span
                                            aria-label={t`Messages from ${sourceName}`}
                                            className={cn(
                                                "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] leading-none font-medium",
                                                MESSENGER_BADGES[node.source]?.className ?? "bg-muted text-muted-foreground",
                                            )}
                                            role="img"
                                        >
                                            {renderMessengerBadgeIcon(node.source)}
                                            <span aria-hidden="true">{node.source}</span>
                                        </span>
                                    }
                                />
                                <TooltipContent>{t`Messages from ${sourceName}`}</TooltipContent>
                            </Tooltip>
                        )}
                    </span>
                </div>
            )}

            {/* The quick actions. Faded out, not removed, so an open menu keeps its anchor and focus has somewhere to return. */}
            <div className="bg-surface-row-hover absolute top-[calc(var(--density-row-py)-3px)] right-2 flex items-center gap-0.5 rounded-lg p-0.5 opacity-0 transition-opacity group-hover/action-item:opacity-100 focus-within:opacity-100 has-[[data-popup-open]]:opacity-100">
                {renderStopButton("contents [@media(hover:none)]:hidden")}

                {node.status !== "archived" && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    aria-label={named(i18n._(getPinTooltip(isPinning, node.isPinned)))}
                                    className="text-muted-foreground hover:text-foreground size-[22px] p-0"
                                    disabled={isPinning}
                                    onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();

                                        if (isPinning) {
                                            return; // Prevent multiple clicks
                                        }

                                        if (node.isPinned) {
                                            handleUnpinThread(node.threadId);
                                        } else {
                                            handlePinThread(node.threadId);
                                        }
                                    }}
                                    size="icon-sm"
                                    type="button"
                                    variant="ghost"
                                >
                                    {isPinning && <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />}
                                    {!isPinning &&
                                        (node.isPinned ? <PinOff aria-hidden="true" className="size-3.5" /> : <Pin aria-hidden="true" className="size-3.5" />)}
                                </Button>
                            }
                        />
                        <TooltipContent>{i18n._(getPinTooltip(isPinning, node.isPinned))}</TooltipContent>
                    </Tooltip>
                )}

                {/* Only roots are sorted into the Snoozed section, so a child has no snooze to set. */}
                {isRootThread && (node.lastReplyAt !== undefined || snoozedUntil !== undefined) && (
                    <DropdownMenu
                        onOpenChange={(open) => {
                            if (open) {
                                setSnoozeMenuNow(Date.now());
                            }
                        }}
                    >
                        <Tooltip>
                            <TooltipTrigger
                                render={
                                    <DropdownMenuTrigger
                                        render={
                                            <Button
                                                aria-label={named(t`Snooze thread`)}
                                                className="text-muted-foreground hover:text-foreground size-[22px] p-0"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                }}
                                                size="icon-sm"
                                                variant="ghost"
                                            >
                                                <AlarmClock aria-hidden="true" className="size-3.5" />
                                            </Button>
                                        }
                                    />
                                }
                            />
                            <TooltipContent>{t`Snooze thread`}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent
                            onClick={(e) => {
                                e.stopPropagation();
                            }}
                        >
                            <DropdownMenuItem onClick={() => snooze(node.threadId, "hour", node.snoozedUntil)}>{t`Snooze 1 hour`}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => snooze(node.threadId, "tomorrow", node.snoozedUntil)}>
                                {t`Snooze until tomorrow 09:00`}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={() => snooze(node.threadId, "nextWeek", node.snoozedUntil)}
                            >{t`Snooze until next week`}</DropdownMenuItem>
                            <DropdownMenuItem onClick={() => setSnoozeThreadId(node.threadId)}>{t`Snooze until…`}</DropdownMenuItem>
                            {isSnoozed(snoozedUntil, snoozeMenuNow) && (
                                <DropdownMenuItem onClick={() => unsnooze(node.threadId, node.snoozedUntil)}>{t`Unsnooze`}</DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}

                {!isImpersonating && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    aria-label={named(i18n._(getArchiveTooltip(isArchiving, node.status)))}
                                    className="text-muted-foreground hover:text-foreground size-[22px] p-0"
                                    disabled={isArchiving}
                                    onClick={(e) => {
                                        e.stopPropagation();

                                        if (isArchiving) {
                                            return;
                                        }

                                        const model = node.model || "gemini-1.5-flash"; // Default model

                                        if (node.status === "archived") {
                                            updateThread(node.threadId, model, "active");
                                        } else {
                                            updateThread(node.threadId, model, "archived");
                                        }
                                    }}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    {isArchiving ? (
                                        <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                                    ) : (
                                        <ArchiveIcon aria-hidden="true" className="size-3.5" />
                                    )}
                                </Button>
                            }
                        />
                        <TooltipContent>{i18n._(getArchiveTooltip(isArchiving, node.status))} </TooltipContent>
                    </Tooltip>
                )}

                <ThreadOptionsMenu {...optionsMenuProps} className="[@media(hover:none)]:hidden" open={isOptionsMenuOpen && canHover} />
            </div>

            {!isImpersonating && (
                <DeleteConfirmationDialog
                    description={t`Are you sure you want to delete this thread? This action cannot be undone and will permanently remove all messages in this conversation.`}
                    isDeleting={isDeleting}
                    onConfirm={() => {
                        if (isDeleting) {
                            return; // Prevent multiple clicks
                        }

                        handleDeleteThread(node.threadId);
                        setShowDeleteDialog(false);
                        // The dialog returns focus to the item that opened it on close, and that item leaves with the row: the toggle gets focus after the return.
                        globalThis.setTimeout(focusThreadSearchToggle, 0);
                    }}
                    onOpenChange={setShowDeleteDialog}
                    open={showDeleteDialog}
                    title={t`Delete Thread`}
                />
            )}
            {lockMode !== null && (
                <ThreadLockDialog
                    mode={lockMode}
                    onOpenChange={(open) => {
                        if (!open) {
                            setLockMode(null);
                        }
                    }}
                    open
                    threadId={node.threadId}
                />
            )}
        </div>
    );

    return (
        <TooltipProvider>
            {isSelectionMode ? (
                <div
                    className={containerClassName}
                    data-thread-id={node.threadId}
                    onClick={(e) => {
                        if (
                            (e.target === e.currentTarget || (e.target as HTMLElement).closest(ACTION_ITEM_SELECTOR) === e.currentTarget) &&
                            index !== undefined
                        ) {
                            handleThreadToggle(node.threadId, index, e.shiftKey);
                        }
                    }}
                    ref={rowRef}
                    role="presentation"
                >
                    {content}
                </div>
            ) : (
                <div
                    className={containerClassName}
                    data-thread-id={node.threadId}
                    onClick={(e) => {
                        const target = e.target as HTMLElement;

                        if (
                            target.tagName === "BUTTON" ||
                            target.tagName === "INPUT" ||
                            target.closest("button") ||
                            target.closest("input") ||
                            target.closest("[role='button']") ||
                            target.closest('[role="checkbox"]')
                        ) {
                            return;
                        }

                        // Prevent navigation when dialogs are open
                        if (showDeleteDialog || showMoveToProjectDialog) {
                            return;
                        }

                        if (!isSelectionMode) {
                            if (isActive) {
                                return;
                            }

                            if (isTransitioningRef.current) {
                                return;
                            }

                            isTransitioningRef.current = true;

                            router.navigate({
                                params: { threadId: node.threadId },
                                search: {},
                                to: "/chat/$threadId",
                            });
                            setTimeout(() => {
                                isTransitioningRef.current = false;
                            }, 100);
                        }
                    }}
                    onMouseEnter={handleMouseEnter}
                    ref={rowRef}
                    role="presentation"
                >
                    {content}
                </div>
            )}

            {/* Only a message search's results carry matches. */}
            {!isSelectionMode && node.relevantMessages && node.relevantMessages.length > 0 && (
                <MessageSearchMatches matches={node.relevantMessages} threadId={node.threadId} />
            )}

            {hasOpenedMoveToProject && (
                <Suspense fallback={null}>
                    <MoveToProjectDialog
                        currentProjectId={node.projectId}
                        onClose={() => setShowMoveToProjectDialog(false)}
                        open={showMoveToProjectDialog}
                        threadId={node.threadId}
                    />
                </Suspense>
            )}

            {hasChildren && isExpanded && (
                <ThreadNodeChildren
                    expandedThreads={expandedThreads}
                    handleCreateBranch={handleCreateBranch}
                    handleDeleteThread={handleDeleteThread}
                    handleDownloadThread={handleDownloadThread}
                    handleMouseEnter={ignoreMouseEnter}
                    handlePinThread={handlePinThread}
                    handleThreadToggle={handleThreadToggle}
                    handleUnpinThread={handleUnpinThread}
                    isSelectionMode={isSelectionMode}
                    loadingStates={loadingStates}
                    nodes={node.children}
                    selectedThreadIds={selectedThreadIds}
                    toggleExpanded={toggleExpanded}
                    updateThread={updateThread}
                />
            )}
        </TooltipProvider>
    );
};

export default ThreadNode;
