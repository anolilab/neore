import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import Discord from "@neore/ui/icons/discord";
import Line from "@neore/ui/icons/line";
import Slack from "@neore/ui/icons/slack";
import Telegram from "@neore/ui/icons/telegram";
import WeChat from "@neore/ui/icons/wechat";
import WhatsApp from "@neore/ui/icons/whatsapp";
import cn from "@neore/ui/utils/cn";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useRouter } from "@tanstack/react-router";
import {
    ArchiveIcon,
    ChevronDown,
    ChevronRight,
    DownloadIcon,
    Folder,
    GitBranch,
    GitCompareArrows,
    GripVertical,
    HourglassIcon,
    Loader2,
    Pin,
    PinOff,
    Radio,
    Send,
    Tag,
    TrashIcon,
    Users,
} from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import usePreloadThread from "@/features/chat/core/hooks/use-preload-thread";
import { THREAD_CATEGORY_LABELS } from "@/features/chat/tags/thread-categories";
import ThreadTagChips from "@/features/chat/tags/thread-tag-chips";
import ThreadTagsMenu from "@/features/chat/tags/thread-tags-menu";
import { useHasOpened } from "@/hooks/use-has-opened";
import { createLunoraQueryOptions, useCRPC, useLunora } from "@/lib/lunora/crpc";
import { LUNORA_ID_SOURCE } from "@/lib/lunora/ids";

import MessageSearchMatches from "./message-search-matches";
import SortableThreadItem from "./sortable-thread-item";
import { selectSetShowManageTagsDialog, useThreadListUIStore } from "./stores/thread-list-ui-store";
import type { BranchNode, LoadingStates } from "./types";

// Lazy: its project icons pull `lucide-react/dynamic`'s import map of every icon (~190KB).
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

const ThreadNodeChildren: FC<{
    currentThreadId: string | undefined;
    expandedThreads: Set<string>;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handleMouseEnter: () => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    isKeyboardNavigating: boolean;
    isSelectionMode: boolean;
    loadingStates: LoadingStates;
    nodes: BranchNode[];
    searchQuery: string;
    selectedThreadIds: Set<string>;
    selectedThreadIndex: number;
    toggleExpanded: (threadId: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}> = ({
    currentThreadId,
    expandedThreads,
    handleCreateBranch,
    handleDeleteThread,
    handleDownloadThread,
    handleMouseEnter,
    handlePinThread,
    handleThreadToggle,
    handleUnpinThread,
    isKeyboardNavigating,
    isSelectionMode,
    loadingStates,
    nodes: children,
    searchQuery,
    selectedThreadIds,
    selectedThreadIndex,
    toggleExpanded,
    updateThread,
}) => (
    <div className="relative">
        {children.map((child, childIndex) => (
            <SortableThreadItem
                currentThreadId={currentThreadId}
                expandedThreads={expandedThreads}
                handleCreateBranch={handleCreateBranch}
                handleDeleteThread={handleDeleteThread}
                handleDownloadThread={handleDownloadThread}
                handleMouseEnter={handleMouseEnter}
                handlePinThread={handlePinThread}
                handleThreadToggle={handleThreadToggle}
                handleUnpinThread={handleUnpinThread}
                index={childIndex}
                isKeyboardNavigating={isKeyboardNavigating}
                isKeyboardSelected={false}
                isSelected={selectedThreadIds.has(child.threadId)}
                isSelectionMode={isSelectionMode}
                key={child.threadId}
                loadingStates={loadingStates}
                node={child}
                searchQuery={searchQuery}
                selectedThreadIds={selectedThreadIds}
                selectedThreadIndex={selectedThreadIndex}
                toggleExpanded={toggleExpanded}
                updateThread={updateThread}
            />
        ))}
    </div>
);

interface ThreadNodeProperties {
    currentThreadId: string | undefined;
    dragListeners?: any;
    expandedThreads: Set<string>;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    index?: number;
    isKeyboardSelected?: boolean;
    isSelected: boolean;
    isSelectionMode: boolean;
    loadingStates: LoadingStates;
    node: BranchNode;
    searchQuery: string;
    selectedThreadIds: Set<string>;
    toggleExpanded: (threadId: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}

const ThreadNode: FC<ThreadNodeProperties> = ({
    currentThreadId,
    dragListeners,
    expandedThreads,
    handleCreateBranch,
    handleDeleteThread,
    handleDownloadThread,
    handlePinThread,
    handleThreadToggle,
    handleUnpinThread,
    index,
    isKeyboardSelected,
    isSelected,
    isSelectionMode,
    loadingStates,
    node,
    searchQuery,
    selectedThreadIds,
    toggleExpanded,
    updateThread,
}) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const lunoraClient = useLunora();
    const router = useRouter();
    const location = useLocation();
    const queryClient = useQueryClient();
    const preloadThread = usePreloadThread();
    const { mutateAsync: convertToPermanent } = useMutation(crpc.chat.functions.convertTemporaryToPermanent.mutationOptions());
    const [isConverting, setIsConverting] = useState(false);
    const [showMoveToProjectDialog, setShowMoveToProjectDialog] = useState(false);
    // Mounted on first open only: rendered closed in every row, the lazy dialog loaded on first paint.
    const hasOpenedMoveToProject = useHasOpened(showMoveToProjectDialog);
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const setShowManageTagsDialog = useThreadListUIStore(selectSetShowManageTagsDialog);
    const isTransitioningRef = useRef(false);

    const urlThreadId = location.pathname.match(CHAT_THREAD_PATH_RE)?.[1];
    const isOnDefaultRoute = location.pathname === "/chat" || location.pathname === "/chat/";

    const isActive = isOnDefaultRoute
        ? false // Never active on default route
        : urlThreadId === node.threadId || (urlThreadId === undefined && currentThreadId === node.threadId && currentThreadId !== "default");
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
    const isFailed = node.status === "error";

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

            // Preload into Lunora cache (for useQuery/usePaginatedQuery hooks)
            preloadThread(node.threadId);

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
                    paginationOpts: THREAD_LIST_PAGINATION_OPTS,
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
    }, [isActive, isSelectionMode, node.threadId, preloadThread, router, queryClient, lunoraClient, crpc]);

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
                "cursor-pointer hover:bg-white/10 focus-visible:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:outline-none",
                isActive && "bg-white/20",
                isKeyboardSelected && "bg-white/10 ring-2 ring-white/50",
                isSelectionMode && isSelected && "bg-white/15",
                !isRootThread && "ml-6",
                (isDeleting || loadingStates.reordering) && "pointer-events-none opacity-50",
            ),
        [isActive, isKeyboardSelected, isSelectionMode, isSelected, isRootThread, isDeleting, loadingStates.reordering],
    );

    const content = (
        <div
            className="group/action-item relative flex items-center gap-2 overflow-hidden rounded-lg px-2.5 py-2"
            onClick={(e) => {
                if (isSelectionMode) {
                    return;
                }

                e.stopPropagation();

                // Prevent navigation when dialogs are open
                if (showDeleteDialog || showMoveToProjectDialog) {
                    return;
                }

                if (isActive) {
                    return;
                }

                if (urlThreadId === node.threadId || currentThreadId === node.threadId) {
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
            onKeyDown={(e) => {
                if (!(e.key === "Enter" || e.key === " ") || isSelectionMode) {
                    return;
                }

                e.preventDefault();
                e.stopPropagation();

                if (!showDeleteDialog && !showMoveToProjectDialog && !isActive && urlThreadId !== node.threadId && currentThreadId !== node.threadId) {
                    router.navigate({ params: { threadId: node.threadId }, search: {}, to: "/chat/$threadId" });
                }
            }}
            role="button"
            tabIndex={-1}
        >
            {isSelectionMode && (
                <Checkbox
                    checked={isSelected}
                    className="border-white/30 data-checked:border-white data-checked:bg-white"
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

            {!isDeleting && !loadingStates.reordering && !isSelectionMode && (
                <div className="opacity-0 transition-opacity group-hover/action-item:opacity-100" {...dragListeners}>
                    <GripVertical className="text-brand-black/60 dark:text-brand-white/60 h-3 w-3 cursor-grab active:cursor-grabbing" />
                </div>
            )}

            {loadingStates.reordering && <Loader2 className="text-brand-black/60 dark:text-brand-white/60 h-3 w-3 animate-spin" />}

            {hasChildren && (
                <Button
                    className="h-4 w-4 p-0"
                    onClick={(e) => {
                        e.stopPropagation();
                        toggleExpanded(node.threadId);
                    }}
                    size="icon-sm"
                    variant="ghost"
                >
                    {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                </Button>
            )}

            <Tooltip>
                <TooltipTrigger
                    render={
                        <span
                            className={cn(
                                "text-brand-black dark:text-brand-white -mr-4 flex flex-1 cursor-pointer items-center gap-1.5 truncate text-sm",
                                node.status === "archived" && "-mr-9",
                            )}
                        >
                            {isStreaming && <Radio aria-label={t`Streaming`} className="text-primary h-3 w-3 shrink-0 animate-pulse" />}
                            {isFailed && <Radio aria-label={t`Failed`} className="text-destructive h-3 w-3 shrink-0" />}
                            {isComparisonParent && <GitCompareArrows aria-label={t`Model comparison`} className="text-muted-foreground h-3 w-3 shrink-0" />}
                            <span className="truncate">{node.title}</span>
                        </span>
                    }
                />
                <TooltipContent className="max-w-xs" side="right">
                    <p className="break-words">{node.title}</p>
                    {isStreaming && <p className="text-muted-foreground mt-1 text-xs">{t`Streaming...`}</p>}
                    {isFailed && <p className="text-destructive mt-1 text-xs">{t`Response failed - try again`}</p>}
                </TooltipContent>
            </Tooltip>

            {node.tags && node.tags.length > 0 && <ThreadTagChips tags={node.tags} />}

            {node.category && node.category !== "general" && (
                <Badge className="text-xs capitalize" variant="secondary">
                    {categoryLabel ? i18n._(categoryLabel) : node.category}
                </Badge>
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

            <div className="bg-accent-foreground/80 absolute right-0 flex items-center gap-1 rounded-l-lg opacity-0 transition-opacity group-hover/action-item:opacity-100 focus-within:opacity-100">
                {node.status !== "archived" && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    className="hover:text-primary h-6 w-6 p-0"
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
                                    {isPinning && <Loader2 className="h-3 w-3 animate-spin" />}
                                    {!isPinning && (node.isPinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />)}
                                </Button>
                            }
                        />
                        <TooltipContent>{i18n._(getPinTooltip(isPinning, node.isPinned))}</TooltipContent>
                    </Tooltip>
                )}

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                className="hover:text-primary h-6 w-6 p-0"
                                disabled={isBranching}
                                onClick={(e) => {
                                    e.stopPropagation();

                                    if (isBranching) {
                                        return; // Prevent multiple clicks
                                    }

                                    handleCreateBranch(node.threadId);
                                }}
                                size="icon-sm"
                                variant="ghost"
                            >
                                {isBranching ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitBranch className="h-3 w-3" />}
                            </Button>
                        }
                    />
                    <TooltipContent>{isBranching ? t`Creating branch...` : t`Create branch`}</TooltipContent>
                </Tooltip>

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                className="hover:text-primary h-6 w-6 p-0"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowMoveToProjectDialog(true);
                                }}
                                size="icon-sm"
                                variant="ghost"
                            >
                                <Folder className="h-3 w-3" />
                            </Button>
                        }
                    />
                    <TooltipContent>{t`Move to project`}</TooltipContent>
                </Tooltip>

                {isTemporary ? (
                    // Temporary chats expire and are deleted, so a tag would outlive
                    // nothing. Shown inert rather than hidden, so the reason is findable.
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    aria-disabled="true"
                                    aria-label={t`Tags unavailable for temporary chats`}
                                    className="h-6 w-6 cursor-not-allowed p-0 opacity-50"
                                    onClick={(e) => {
                                        e.stopPropagation();
                                    }}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    <Tag aria-hidden="true" className="h-3 w-3" />
                                </Button>
                            }
                        />
                        <TooltipContent className="max-w-56">{t`Temporary chats expire, so they can't be tagged. Convert it to a permanent chat to add tags.`}</TooltipContent>
                    </Tooltip>
                ) : (
                    <ThreadTagsMenu
                        onManageTags={() => {
                            setShowManageTagsDialog(true);
                        }}
                        tagIds={node.tagIds}
                        threadId={node.threadId}
                        threadTitle={node.title}
                    />
                )}

                <DropdownMenu>
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <DropdownMenuTrigger
                                    render={
                                        <Button
                                            className="hover:text-primary h-6 w-6 p-0"
                                            disabled={isDownloading}
                                            onClick={(e) => {
                                                e.stopPropagation();
                                            }}
                                            size="icon-sm"
                                            variant="ghost"
                                        >
                                            {isDownloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <DownloadIcon className="h-3 w-3" />}
                                        </Button>
                                    }
                                />
                            }
                        />
                        <TooltipContent>{isDownloading ? t`Downloading...` : t`Download thread`}</TooltipContent>
                    </Tooltip>
                    <DropdownMenuContent
                        onClick={(e) => {
                            e.stopPropagation();
                        }}
                    >
                        <DropdownMenuItem onClick={() => handleDownloadThread(node, "json")}>JSON</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownloadThread(node, "txt")}>TXT</DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleDownloadThread(node, "pdf")}>PDF</DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                className="hover:text-primary h-6 w-6 p-0"
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
                                {isArchiving ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArchiveIcon className="h-3 w-3" />}
                            </Button>
                        }
                    />
                    <TooltipContent>{i18n._(getArchiveTooltip(isArchiving, node.status))} </TooltipContent>
                </Tooltip>

                {isTemporary && (
                    <Tooltip>
                        <TooltipTrigger
                            render={
                                <Button
                                    className="hover:text-primary h-6 w-6 p-0"
                                    disabled={isConverting}
                                    onClick={async (e) => {
                                        e.stopPropagation();

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
                                    }}
                                    size="icon-sm"
                                    variant="ghost"
                                >
                                    {isConverting ? <Loader2 className="h-3 w-3 animate-spin" /> : <HourglassIcon className="h-3 w-3" />}
                                </Button>
                            }
                        />
                        <TooltipContent>{isConverting ? t`Converting...` : t`Convert to permanent`}</TooltipContent>
                    </Tooltip>
                )}

                <Tooltip>
                    <TooltipTrigger
                        render={
                            <Button
                                className="hover:text-destructive h-6 w-6 p-0"
                                disabled={isDeleting}
                                onClick={(e) => {
                                    e.stopPropagation();
                                    setShowDeleteDialog(true);
                                }}
                                size="icon-sm"
                                variant="ghost"
                            >
                                {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <TrashIcon className="h-3 w-3" />}
                            </Button>
                        }
                    />
                    <TooltipContent>{isDeleting ? t`Deleting...` : t`Delete thread`}</TooltipContent>
                </Tooltip>
                <DeleteConfirmationDialog
                    description={t`Are you sure you want to delete this thread? This action cannot be undone and will permanently remove all messages in this conversation.`}
                    isDeleting={isDeleting}
                    onConfirm={() => {
                        if (isDeleting) {
                            return; // Prevent multiple clicks
                        }

                        handleDeleteThread(node.threadId);
                        setShowDeleteDialog(false);
                    }}
                    onOpenChange={setShowDeleteDialog}
                    open={showDeleteDialog}
                    title={t`Delete Thread`}
                />
            </div>

            {isTemporary && (
                <Tooltip>
                    <TooltipTrigger
                        render={
                            <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                                <HourglassIcon className="h-3 w-3 shrink-0" />
                                {remainingTime && <span>{remainingTime}</span>}
                            </div>
                        }
                    />
                    <TooltipContent>{remainingTime ? t`Expires in ${remainingTime}` : t`Temporary chat`}</TooltipContent>
                </Tooltip>
            )}
            {node.status === "archived" && <ArchiveIcon className="text-muted-foreground h-3 w-3 shrink-0" />}
            {searchQuery.trim() && node.relevantMessages && node.relevantMessages.length > 0 && (
                <div className="bg-primary/10 text-primary shrink-0 rounded-full px-1.5 py-0.5 text-xs">
                    <Plural one="# match" other="# matches" value={node.relevantMessages.length} />
                </div>
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
                    onKeyDown={(e) => {
                        if (!(e.key === "Enter" || e.key === " ") || index === undefined) {
                            return;
                        }

                        e.preventDefault();
                        handleThreadToggle(node.threadId, index, false);
                    }}
                    role="button"
                    tabIndex={0}
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

                            if (urlThreadId === node.threadId || currentThreadId === node.threadId) {
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
                    onKeyDown={(e) => {
                        if (!(e.key === "Enter" || e.key === " ")) {
                            return;
                        }

                        e.preventDefault();

                        if (!showDeleteDialog && !showMoveToProjectDialog && !isActive && urlThreadId !== node.threadId && currentThreadId !== node.threadId) {
                            router.navigate({ params: { threadId: node.threadId }, search: {}, to: "/chat/$threadId" });
                        }
                    }}
                    onMouseEnter={handleMouseEnter}
                    role="button"
                    tabIndex={0}
                >
                    {content}
                </div>
            )}

            {searchQuery.trim() && !isSelectionMode && node.relevantMessages && node.relevantMessages.length > 0 && (
                <MessageSearchMatches matches={node.relevantMessages} searchQuery={searchQuery} threadId={node.threadId} />
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
                    currentThreadId={currentThreadId}
                    expandedThreads={expandedThreads}
                    handleCreateBranch={handleCreateBranch}
                    handleDeleteThread={handleDeleteThread}
                    handleDownloadThread={handleDownloadThread}
                    handleMouseEnter={() => {}}
                    handlePinThread={handlePinThread}
                    handleThreadToggle={handleThreadToggle}
                    handleUnpinThread={handleUnpinThread}
                    isKeyboardNavigating={false}
                    isSelectionMode={isSelectionMode}
                    loadingStates={loadingStates}
                    nodes={node.children}
                    searchQuery={searchQuery}
                    selectedThreadIds={selectedThreadIds}
                    selectedThreadIndex={-1}
                    toggleExpanded={toggleExpanded}
                    updateThread={updateThread}
                />
            )}
        </TooltipProvider>
    );
};

export default ThreadNode;
