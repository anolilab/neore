import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import {
    Command,
    CommandCollection,
    CommandDialog,
    CommandDialogPopup,
    CommandEmpty,
    CommandFooter,
    CommandGroup,
    CommandGroupLabel,
    CommandInput,
    CommandItem,
    CommandList,
    CommandPanel,
    CommandSeparator,
    CommandShortcut,
} from "@neore/ui/components/command";
import { Kbd, KbdGroup } from "@neore/ui/components/kbd";
import { Toggle } from "@neore/ui/components/toggle";
import useIsHydrated from "@neore/ui/hooks/use-hydrated";
import { formatShortcutForDisplay } from "@neore/ui/utils/keyboard-shortcuts";
import type { Query } from "@tanstack/react-query";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouter } from "@tanstack/react-router";
import {
    Archive,
    ArchiveRestore,
    ArrowDownIcon,
    ArrowUpIcon,
    CornerDownLeftIcon,
    CornerDownRightIcon,
    File,
    FileText,
    Folder,
    GitBranch,
    Hourglass,
    MessageSquare,
    Pin,
    PinOff,
    Settings,
    Sparkles,
    Trash2,
} from "lucide-react";
import type { FC } from "react";
import React, { useEffect, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useImpersonating } from "@/features/admin/hooks/use-is-impersonating";
import { useAuthSession } from "@/features/auth/hooks/use-auth-session";
import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import useAllThreadsData from "@/features/chat/core/hooks/use-all-threads-data";
import useCurrentModel from "@/features/chat/core/hooks/use-current-model";
import { useThreadManager } from "@/features/chat/core/hooks/use-thread-manager";
import { useCurrentThreadId, useThreadMetadata } from "@/features/chat/core/stores/thread-store-hooks";
import { errorCode } from "@/features/chat/guest-links/error-code";
import { scrollToMessage } from "@/features/chat/thread/message-list";
import useThreadHandlers from "@/features/chat/thread-list/hooks/use-thread-handlers";
import type { ThreadState } from "@/features/chat/thread-list/lib/derived-sections";
import { nextSnoozeWake, threadStateOf } from "@/features/chat/thread-list/lib/derived-sections";
import { compareByStateRank, parseStateQuery } from "@/features/chat/thread-list/lib/state-query";
import { isThreadLocked } from "@/features/chat/thread-list/thread-lock";
import { buildMatchSnippet } from "@/features/chat/thread-list/utilities";
import convertShortcutToHotkeysHook from "@/features/keyboard/lib/shortcut-converter";
import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";
import { useProjectList } from "@/features/projects/hooks/use-projects";
import useDebouncedValue from "@/hooks/use-debounced-value";
import type { ApiPath } from "@/lib/lunora/crpc";
import { useAction, useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import { useCommandDialogActions, useCommandDialogState, useCommandDialogStore } from "./command-dialog-store";
import type { PaletteScope } from "./command-palette-scope";
import {
    isPaletteScoped,
    matchesWithinWords,
    NO_PALETTE_SCOPE,
    projectRowsVisible,
    threadRowsVisible,
    threadRowVisible,
    unscopedRowsVisible,
} from "./command-palette-scope";

("use client");

/** Fewer characters match too much to be worth a full-text query per pause. */
const MESSAGE_SEARCH_MIN_CHARS = 2;
const MESSAGE_SEARCH_DEBOUNCE_MS = 250;
const MAX_MESSAGE_HITS = 8;
/** The meaning search embeds the query, so it waits for a few characters, as the backend does (`agent/thread-search-plan.ts`). */
const MEANING_SEARCH_MIN_CHARS = 3;
/** The longest query `searchThreadsByMeaning` accepts (`agent/thread-search.ts`); a longer one is not sent. */
const MEANING_SEARCH_MAX_CHARS = 2000;
const MAX_MEANING_HITS = 10;
/** The meaning hits' key prefix, removed when the palette closes. */
const MEANING_QUERY_KEY = ["command-palette", "meaning"] as const;
/** How long a query's meaning hits are reused while the palette is open, so editing back to it does not embed it again. */
const MEANING_CACHE_MS = 60_000;
/** The longest delay setTimeout accepts; a timer capped by it re-arms when it fires (the effect reads `now`). */
const MAX_TIMEOUT_MS = 2_147_483_647;

interface ThreadWriteArgs {
    status?: unknown;
    threadId?: unknown;
    threadIds?: unknown;
    title?: unknown;
}

/** Which cached meaning queries a write marks stale: every one, only the archived-only ones, or none. */
type MeaningHitsChange = "all" | "archived" | undefined;

/**
 * Which meaning hits a finished write changes (a hit's title, archived state or existence), told apart by the function it called
 * (its `mutationKey`, `lunoraMutationKey`). Hiding a thread (delete) matters only for a listed one. An archive hides a listed
 * thread and adds one to every archived-only search, where a thread just archived cannot be listed yet. A rename, a restore from
 * the archive or an undone delete can add a hit anywhere, so each marks every query stale. Anything else, a sent message or a
 * model change, keeps them, so it never pays for the embedding again.
 */
const changesMeaningHits = (mutationKey: ReadonlyArray<unknown> | undefined, variables: unknown, listedIds: ReadonlySet<string>): MeaningHitsChange => {
    if (mutationKey?.[0] !== "lunora" || typeof variables !== "object" || variables === null) {
        return undefined;
    }

    const args = variables as ThreadWriteArgs;
    const isListed = (id: unknown): boolean => typeof id === "string" && listedIds.has(id);

    switch (mutationKey[1] as ApiPath) {
        case "chat_functions:deleteThreads": {
            return Array.isArray(args.threadIds) && args.threadIds.some((id: unknown) => isListed(id)) ? "all" : undefined;
        }
        case "chat_functions:softDeleteThread": {
            return isListed(args.threadId) ? "all" : undefined;
        }
        case "chat_functions:undoDeleteThread": {
            return "all";
        }
        case "chat_functions:updateThread": {
            if (args.title !== undefined || args.status === "active" || (args.status === "archived" && isListed(args.threadId))) {
                return "all";
            }

            return args.status === "archived" ? "archived" : undefined;
        }
        default: {
            return undefined;
        }
    }
};

interface MessageSearchThread {
    _id: string;
    relevantMessages?: { _id: string; order: number; stepOrder: number; text?: string }[];
    title?: string;
}

interface MessageHit {
    message: { _id: string; order: number; stepOrder: number; text: string };
    threadId: string;
    threadTitle?: string;
}

/**
 * The matching messages that have text, capped for a palette. The server groups hits by thread and orders the threads by match count, so
 * taking the first few would let one busy thread fill every slot; instead each thread gets a slot per round, keeping its own relevance order.
 */
const collectMessageHits = (threads: MessageSearchThread[] = []): MessageHit[] => {
    const queues = threads.map((thread) =>
        (thread.relevantMessages ?? [])
            .filter((message) => message.text?.trim())
            .map((message) => {
                return { message, thread };
            }),
    );
    const hits: MessageHit[] = [];

    for (let round = 0; hits.length < MAX_MESSAGE_HITS && queues.some((queue) => round < queue.length); round += 1) {
        for (const queue of queues) {
            const entry = queue[round];

            if (entry && hits.length < MAX_MESSAGE_HITS) {
                hits.push({ message: { ...entry.message, text: entry.message.text as string }, threadId: entry.thread._id, threadTitle: entry.thread.title });
            }
        }
    }

    return hits;
};

interface Item {
    detail?: string;
    icon?: React.ReactNode;
    isCurrent?: boolean;
    isMeaningHit?: boolean;
    isMessageHit?: boolean;
    label: string;
    onClick?: () => void;
    shortcut?: string;
    status?: "active" | "archived";
    threadId?: string;
    value: string;
}

interface Group {
    items: Item[];
    value: string;
}

interface ThreadItem {
    id: string;
    /** A locked chat's list row is a stub without its project, so a project filter cannot place it. */
    isLocked?: boolean;
    isPinned?: boolean;
    projectId?: string;
    state: ThreadState;
    status: "active" | "archived";
    title: string;
}

/** A project the palette is narrowed to: its thread rows only. */
interface ProjectFilter {
    id: string;
    title: string;
}

interface GlobalCommandPaletteContentProps {
    isMounted: boolean;
}

const GlobalCommandPaletteContent: FC<GlobalCommandPaletteContentProps> = ({ isMounted }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate({ from: "/chat/$threadId" as "/chat/$threadId" | "/dashboard" });
    const { keyboardShortcuts } = useKeyboardShortcuts();
    const { isOpen } = useCommandDialogState();
    const { close, setOpen } = useCommandDialogActions();
    const queryClient = useQueryClient();

    const currentThreadId = useCurrentThreadId();
    const threadMetadata = useThreadMetadata();
    const currentThreadModel = useCurrentModel();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();
    const router = useRouter();

    const isAuthReady = isAuthenticated && !isAuthLoading;
    const shouldQuery = isOpen && isAuthReady;

    const allThreadsData = useAllThreadsData(shouldQuery);
    const { deleteBranch, switchToBranch } = useThreadManager(shouldQuery);
    const { data: pinnedThreads } = useQuery(crpc.chat.functions.getPinnedThreads.queryOptions(shouldQuery ? {} : skipToken));

    // The palette's input text: message search follows it, and picking a project clears it.
    const [searchInput, setSearchInput] = useState("");
    // The thread delete waiting for confirmation. It opens the same destructive dialog the sidebar row uses.
    const [pendingDelete, setPendingDelete] = useState<{ run: () => void } | undefined>(undefined);
    // The filters and the project the palette is narrowed to. Each closes with the palette.
    const [scope, setScope] = useState<PaletteScope>(NO_PALETTE_SCOPE);
    const [projectFilter, setProjectFilter] = useState<ProjectFilter | undefined>(undefined);

    if (!isOpen && (searchInput !== "" || isPaletteScoped(scope) || projectFilter !== undefined)) {
        setSearchInput("");
        setScope(NO_PALETTE_SCOPE);
        setProjectFilter(undefined);
    }

    // The meaning hits are kept a minute so editing a query back does not embed it again, but not past the open palette.
    useEffect(() => {
        if (!isOpen) {
            queryClient.removeQueries({ queryKey: MEANING_QUERY_KEY });
        }
    }, [isOpen, queryClient]);

    // A renamed, archived, restored or deleted thread changes the hits, wherever the edit was made, so such a write marks them stale
    // once it succeeds (`changesMeaningHits`). The listed threads are those of every meaning query still cached.
    useEffect(
        () =>
            queryClient.getMutationCache().subscribe((event) => {
                if (event.type !== "updated" || event.action.type !== "success") {
                    return;
                }

                const listedIds = new Set(
                    queryClient
                        .getQueriesData<{ threadId: string }[]>({ queryKey: MEANING_QUERY_KEY })
                        .flatMap(([, hits]: [unknown, { threadId: string }[] | undefined]) => (hits ?? []).map((hit: { threadId: string }) => hit.threadId)),
                );

                const change = changesMeaningHits(event.mutation.options.mutationKey, event.mutation.state.variables, listedIds);

                if (change === "all") {
                    void queryClient.invalidateQueries({ queryKey: MEANING_QUERY_KEY });
                } else if (change === "archived") {
                    // The key's `scope.archived` (after the account): an archived-only search.
                    void queryClient.invalidateQueries({
                        predicate: (query: Query) => query.queryKey[MEANING_QUERY_KEY.length + 1] === true,
                        queryKey: MEANING_QUERY_KEY,
                    });
                }
            }),
        [queryClient],
    );

    // Message search is a full-text query: it waits for the palette to be open, for
    // two characters and for the typing to pause, and is never live (NEVER_LIVE).
    // While the input and the debounced query differ, the query is skipped and no hits show.
    const trimmedSearch = searchInput.trim();
    const debouncedSearch = useDebouncedValue(trimmedSearch, MESSAGE_SEARCH_DEBOUNCE_MS);
    // A state tag narrows to threads and drops message hits, so a tagged input never needs the full-text query.
    const isStateTagged = parseStateQuery(trimmedSearch).state !== undefined;
    // A filter narrows the palette to its kinds: navigation, actions and message hits show only without one.
    const unscopedRows = unscopedRowsVisible(scope) && projectFilter === undefined;
    const isMessageSearchCurrent =
        shouldQuery && unscopedRows && !isStateTagged && trimmedSearch.length >= MESSAGE_SEARCH_MIN_CHARS && trimmedSearch === debouncedSearch;
    const { data: messageSearchResults } = useQuery(
        crpc.chat.functions.searchMessages.queryOptions(
            isMessageSearchCurrent ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS, searchQuery: debouncedSearch } : skipToken,
        ),
    );

    // Search by meaning embeds the query on the server, so it waits as message search does. Its hits are threads, so it is not
    // asked for while the palette is narrowed to a project or to project rows.
    const searchMeaning = useAction(api.agent.thread_search.searchThreadsByMeaning);
    // The hits are one account's thread titles: the key names the account, so a switch never shows the previous one's.
    const { data: sessionData } = useAuthSession();
    const sessionUserId = sessionData?.user.id;
    const isMeaningSearchCurrent =
        shouldQuery &&
        !isStateTagged &&
        threadRowsVisible(scope) &&
        projectFilter === undefined &&
        sessionUserId !== undefined &&
        trimmedSearch.length >= MEANING_SEARCH_MIN_CHARS &&
        trimmedSearch.length <= MEANING_SEARCH_MAX_CHARS &&
        trimmedSearch === debouncedSearch;
    const {
        data: meaningHits,
        error: meaningSearchError,
        isError: isMeaningSearchFailed,
    } = useQuery({
        // The hits are a user's own thread titles: kept briefly while the palette is open, removed when it closes (above).
        gcTime: MEANING_CACHE_MS,
        queryFn: isMeaningSearchCurrent ? () => searchMeaning({ archivedOnly: scope.archived, query: debouncedSearch }) : skipToken,
        queryKey: [...MEANING_QUERY_KEY, sessionUserId, scope.archived, debouncedSearch],
        // Each try embeds the query again, so a failure is said (below) and never retried on its own; a refusal by the
        // account's model rules would only be refused again.
        retry: false,
        staleTime: MEANING_CACHE_MS,
    });
    // Project rows show only under the Projects filter, so the list is read only then.
    const { hasMore: hasMoreProjects, isError: isProjectListFailed, projects } = useProjectList(shouldQuery && scope.projects);

    const setLoadingStates = () => {};
    const { confirmBeforeDelete, confirmDialog, handleCreateBranch, handlePinThread, handleUnpinThread, updateThread } = useThreadHandlers(setLoadingStates);
    // An admin acting as the owner may not archive or delete their chats: the server refuses both.
    const isImpersonating = useImpersonating();

    const pinnedThreadIds = new Set(
        pinnedThreads
            ?.map((pin) =>
                typeof pin === "object" && pin !== null && "_id" in pin && typeof pin._id === "string" ? pin._id : (pin as { threadId?: string })?.threadId,
            )
            .filter((id): id is string => typeof id === "string") || [],
    );

    // The clock the states are read against: re-read when the palette opens, and again at each snooze expiry while it stays open.
    const [now, setNow] = useState(() => Date.now());
    const snoozeWake = nextSnoozeWake((allThreadsData.lunora ?? []) as { snoozedUntil?: number }[], now);

    useEffect(() => {
        if (isOpen) {
            setNow(Date.now());
        }
    }, [isOpen]);

    useEffect(() => {
        if (!isOpen || snoozeWake === undefined) {
            return undefined;
        }

        const delay = Math.min(Math.max(snoozeWake - Date.now(), 0) + 25, MAX_TIMEOUT_MS);
        const timer = setTimeout(() => {
            setNow(Date.now());
        }, delay);

        return () => {
            clearTimeout(timer);
        };
        // `now` too: a wake past the timer's cap fires early with the same next wake, and must arm the next timer.
    }, [isOpen, now, snoozeWake]);

    const allThreads: ThreadItem[] = ((): ThreadItem[] => {
        const threads: ThreadItem[] = [];
        const lunoraThreads = allThreadsData.lunora || [];

        for (const thread of lunoraThreads) {
            const threadId = typeof thread === "object" && thread !== null && "_id" in thread && typeof thread._id === "string" ? thread._id : undefined;

            if (!threadId) {
                continue;
            }

            if (threads.every((candidate) => candidate.id !== threadId)) {
                const metadata = threadMetadata.get(threadId);
                const threadStatus = (thread as { status?: "active" | "archived" })?.status;
                const threadTitle = (thread as { title?: string })?.title;
                const row = thread as {
                    awaitingInput?: "approval" | "question";
                    lastReplyAt?: number;
                    lastUserMessageAt?: number;
                    scheduled?: boolean;
                    snoozedUntil?: number;
                    status?: string;
                };

                threads.push({
                    id: threadId,
                    isLocked: isThreadLocked((thread as { lockedAt?: unknown }).lockedAt),
                    isPinned: pinnedThreadIds.has(threadId),
                    projectId: (thread as { projectId?: string }).projectId,
                    state: threadStateOf(
                        {
                            awaitingInput: row.awaitingInput,
                            lastReplyAt: row.lastReplyAt,
                            lastUserMessageAt: row.lastUserMessageAt,
                            scheduled: row.scheduled,
                            snoozedUntil: row.snoozedUntil,
                            // An archived thread counts as archived when its metadata says so, even if the row does not yet.
                            status: metadata?.status === "archived" || row.status === "archived" ? "archived" : (row.status ?? "active"),
                        },
                        now,
                    ),
                    status: metadata?.status === "archived" || threadStatus === "archived" ? "archived" : "active",
                    title: metadata?.title || threadTitle || t`Untitled Thread`,
                });
            }
        }

        for (const [threadId, metadata] of threadMetadata.entries()) {
            if (threads.every((candidate) => candidate.id !== threadId)) {
                threads.push({
                    id: threadId,
                    isPinned: pinnedThreadIds.has(threadId),
                    // Stored metadata carries no run or reply state, so these rows have no state tag.
                    state: "other",
                    status: metadata.status === "archived" ? "archived" : "active",
                    title: metadata.title || t`Untitled Thread`,
                });
            }
        }

        // Working threads first, so a running chat is the first thing the palette shows.
        return threads.toSorted(compareByStateRank);
    })();

    const handleNavigateToSettings = () => {
        navigate({
            search: (previous: Record<string, unknown>) => {
                return {
                    ...previous,
                    settings: true,
                    settingsTab: "app-customization",
                };
            },
        });
        close();
    };

    const handleNavigateToChat = () => {
        navigate({ search: {}, to: "/chat" });
        close();
    };

    const handleNavigateToPrompts = () => {
        navigate({ to: "/prompts" });
        close();
    };

    const handleNavigateToVault = () => {
        navigate({ to: "/vault" });
        close();
    };

    const handleSwitchThread = (threadId: string) => {
        if (!switchToBranch) {
            return;
        }

        switchToBranch(threadId);
        close();
    };

    const handleDeleteThread = async (threadId: string) => {
        if (threadId === "default" || !deleteBranch) {
            return;
        }

        try {
            const { threadDeleted } = await deleteBranch(threadId);

            if (!threadDeleted) {
                showError(t`Failed to delete thread`);

                return;
            }

            close();
        } catch (error) {
            console.error("Failed to delete thread:", error);
            showError(t`Failed to delete thread`);
        }
    };

    const handleNewTemporaryThread = () => {
        globalThis.dispatchEvent(new CustomEvent("newTemporaryChat"));
        close();
    };

    const handleCreateBranchAction = () => {
        if (!(currentThreadId && currentThreadId !== "default" && handleCreateBranch)) {
            return;
        }

        handleCreateBranch(currentThreadId);
        close();
    };

    const handlePinUnpinThread = () => {
        if (!currentThreadId || currentThreadId === "default") {
            return;
        }

        const currentThread = allThreads.find((candidate) => candidate.id === currentThreadId);

        if (currentThread?.isPinned && handleUnpinThread) {
            handleUnpinThread(currentThreadId);
        } else if (!currentThread?.isPinned && handlePinThread) {
            handlePinThread(currentThreadId);
        }

        close();
    };

    // With the setting on, the palette closes and the destructive dialog opens; the delete runs only on confirm.
    const askBeforeDelete = (run: () => void) => {
        close();
        setPendingDelete({ run });
    };

    const handleDeleteCurrentThread = () => {
        if (!(currentThreadId && currentThreadId !== "default" && deleteBranch)) {
            return;
        }

        // The row reappears if the server refuses; nothing is reported deleted before it confirms.
        const remove = () => {
            deleteBranch(currentThreadId)
                .then(({ threadDeleted }) => {
                    if (!threadDeleted) {
                        showError(t`Failed to delete thread`);
                    }

                    return undefined;
                })
                .catch((error: unknown) => {
                    console.error("Failed to delete thread:", error);
                    showError(t`Failed to delete thread`);
                });
        };

        if (confirmBeforeDelete) {
            askBeforeDelete(remove);

            return;
        }

        remove();
        close();
    };

    const handleArchiveCurrentThread = () => {
        if (!currentThreadId || currentThreadId === "default") {
            return;
        }

        const currentThread = allThreads.find((candidate) => candidate.id === currentThreadId);

        if (currentThread && updateThread) {
            updateThread(currentThreadId, currentThreadModel, currentThread.status === "archived" ? "active" : "archived");
            close();
        }
    };

    const handleOpenMessage = (threadId: string, message: { _id: string; order: number; stepOrder: number }) => {
        void router.navigate({ hash: `message-${message._id}`, params: { threadId }, search: {}, to: "/chat/$threadId" });
        scrollToMessage(message._id, { position: { order: message.order, stepOrder: message.stepOrder }, threadId });
        close();
    };

    // A leading `#state` tag narrows the thread lists to that state; the rest of the input searches their titles.
    const stateFilter = parseStateQuery(searchInput).state;
    const visibleThreads = stateFilter === undefined ? allThreads : allThreads.filter((candidate) => candidate.state === stateFilter);
    // A locked chat's stub does not say its project, so under a chosen project it cannot be listed or ruled out.
    const projectMayMissLocked =
        projectFilter !== undefined && visibleThreads.some((candidate) => candidate.isLocked === true && threadRowVisible(scope, candidate.status));

    const groupedItems = (() => {
        const groups: Group[] = [];

        const navigationItems: Item[] = [
            {
                icon: <MessageSquare className="size-4" />,
                label: t`Go to Chat`,
                onClick: handleNavigateToChat,
                value: "nav-chat",
            },
            {
                icon: <FileText className="size-4" />,
                label: t`Go to Prompts`,
                onClick: handleNavigateToPrompts,
                value: "nav-prompts",
            },
            {
                icon: <File className="size-4" />,
                label: t`Go to Vault`,
                onClick: handleNavigateToVault,
                value: "nav-vault",
            },
            {
                icon: <Settings className="size-4" />,
                label: t`Go to Settings`,
                onClick: handleNavigateToSettings,
                value: "nav-settings",
            },
        ];

        if (unscopedRows && navigationItems.length > 0) {
            groups.push({ items: navigationItems, value: t`Navigation` });
        }

        const hasCurrentThread = Boolean(currentThreadId && typeof currentThreadId === "string" && currentThreadId !== "default" && currentThreadId.length > 0);
        const currentThread = hasCurrentThread ? allThreads.find((candidate) => candidate.id === currentThreadId) : undefined;

        const threadActions: Item[] = [
            {
                icon: <MessageSquare className="size-4" />,
                label: t`New thread`,
                onClick: handleNavigateToChat,
                shortcut: keyboardShortcuts.newChat || "ctrl+n",
                value: "action-new-thread",
            },
            {
                icon: <Hourglass className="size-4" />,
                label: t`New temporary thread`,
                onClick: handleNewTemporaryThread,
                shortcut: keyboardShortcuts.newTemporaryChat || "ctrl+shift+n",
                value: "action-new-temporary-thread",
            },
        ];

        if (hasCurrentThread && typeof deleteBranch === "function") {
            threadActions.push(
                {
                    icon: <GitBranch className="size-4" />,
                    label: t`Create branch`,
                    onClick: handleCreateBranchAction,
                    value: "action-create-branch",
                },
                {
                    icon: currentThread?.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />,
                    label: currentThread?.isPinned ? t`Unpin thread` : t`Pin thread`,
                    onClick: handlePinUnpinThread,
                    value: "action-pin-unpin-thread",
                },
            );

            if (!isImpersonating) {
                threadActions.push(
                    {
                        icon: <Archive className="size-4" />,
                        label: currentThread?.status === "archived" ? t`Unarchive thread` : t`Archive thread`,
                        onClick: handleArchiveCurrentThread,
                        value: "action-archive-thread",
                    },
                    {
                        icon: <Trash2 className="size-4" />,
                        label: t`Delete thread`,
                        onClick: handleDeleteCurrentThread,
                        value: "action-delete-thread",
                    },
                );
            }
        }

        if (unscopedRows) {
            groups.push({ items: threadActions, value: t`Thread Actions` });
        }

        // The thread rows the filters and the project let through; a row is listed only when its title matches the typed text.
        const shownThreads = visibleThreads.filter(
            (candidate) => threadRowVisible(scope, candidate.status) && (projectFilter === undefined || candidate.projectId === projectFilter.id),
        );

        if (projectRowsVisible(scope) && projectFilter === undefined && projects.length > 0) {
            groups.push({
                items: projects.map((project) => {
                    return {
                        icon: <Folder aria-hidden="true" className="size-4" />,
                        label: project.title,
                        onClick: () => {
                            setProjectFilter({ id: project._id, title: project.title });
                            // Only the Projects filter is done; Threads and Archived still narrow the project's threads.
                            setScope({ ...scope, projects: false });
                            // The text found the project; left in place it would narrow the project's threads by the project's name.
                            setSearchInput("");
                        },
                        value: `project-${project._id}`,
                    };
                }),
                value: t`Projects`,
            });
        }

        if (allThreads.length > 0) {
            const activeThreads = shownThreads.filter((candidate) => candidate.status === "active");
            const archivedThreads = shownThreads.filter((candidate) => candidate.status === "archived");

            if (activeThreads.length > 0) {
                groups.push({
                    items: activeThreads.map((thread) => {
                        return {
                            icon: <MessageSquare className="size-4" />,
                            isCurrent: currentThreadId === thread.id,
                            label: thread.title,
                            onClick: () => handleSwitchThread(thread.id),
                            status: "active" as const,
                            threadId: thread.id,
                            value: `thread-active-${thread.id}`,
                        };
                    }),
                    value: t`Active Threads`,
                });
            }

            if (archivedThreads.length > 0) {
                groups.push({
                    items: archivedThreads.map((thread) => {
                        return {
                            icon: <Archive className="size-4" />,
                            isCurrent: currentThreadId === thread.id,
                            label: thread.title,
                            onClick: () => handleSwitchThread(thread.id),
                            status: "archived" as const,
                            threadId: thread.id,
                            value: `thread-archived-${thread.id}`,
                        };
                    }),
                    value: t`Archived Threads`,
                });
            }
        }

        const messageHits = isMessageSearchCurrent && unscopedRows ? collectMessageHits(messageSearchResults?.page as MessageSearchThread[] | undefined) : [];

        if (messageHits.length > 0) {
            groups.push({
                items: messageHits.map((hit) => {
                    return {
                        detail: hit.threadTitle || t`Untitled Thread`,
                        icon: <CornerDownRightIcon aria-hidden="true" className="size-4" />,
                        isMessageHit: true,
                        label: buildMatchSnippet(hit.message.text, debouncedSearch),
                        onClick: () => handleOpenMessage(hit.threadId, hit.message),
                        value: `message-${hit.message._id}`,
                    };
                }),
                value: t`Messages`,
            });
        }

        // Meaning hits come after the exact matches. A thread whose title already matches the typed text is listed above, not again.
        // The hits are shown only for the query they were asked for: the debounced one may still be behind the input.
        const exactIds = new Set(shownThreads.filter((candidate) => matchesWithinWords(candidate.title, trimmedSearch)).map((candidate) => candidate.id));
        const meaningRows = (isMeaningSearchCurrent ? (meaningHits ?? []) : [])
            .filter((hit) => !exactIds.has(hit.threadId) && threadRowVisible(scope, hit.archived ? "archived" : "active"))
            .slice(0, MAX_MEANING_HITS);

        if (meaningRows.length > 0) {
            groups.push({
                items: meaningRows.map((hit) => {
                    return {
                        icon: <Sparkles aria-hidden="true" className="size-4" />,
                        isMeaningHit: true,
                        label: hit.title ?? t`Untitled Thread`,
                        onClick: () => handleSwitchThread(hit.threadId),
                        status: hit.archived ? ("archived" as const) : ("active" as const),
                        threadId: hit.threadId,
                        value: `meaning-${hit.threadId}`,
                    };
                }),
                value: t`Related threads`,
            });
        }

        // With a state tag the palette lists threads only: actions, navigation and message hits drop out.
        if (stateFilter === undefined) {
            return groups;
        }

        return groups.flatMap((group) => {
            const items = group.items.filter((item) => item.threadId !== undefined);

            return items.length > 0 ? [{ ...group, items }] : [];
        });
    })();

    // Message hits come from the server's full-text match, which need not contain the
    // typed text verbatim, so only the local items are narrowed by the input.
    const filterItem = (item: unknown, query: string) => {
        const candidate = item as Item;
        const { state, text } = parseStateQuery(query);

        // With a state tag the input narrows by title only; the tag already picked the threads.
        if (state !== undefined) {
            return matchesWithinWords(candidate.label, text);
        }

        // Message and meaning hits were matched on the server, not by their label, so the typed text does not drop them.
        return candidate.isMessageHit === true || candidate.isMeaningHit === true || matchesWithinWords(candidate.label, query);
    };

    const handleCommandPaletteToggle = (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const store = useCommandDialogStore.getState();

        if (store.isOpen) {
            store.close();
        } else {
            store.openCommandPalette();
        }
    };

    useHotkeys(
        convertShortcutToHotkeysHook(keyboardShortcuts.commandPalette || "ctrl+k"),
        handleCommandPaletteToggle,
        {
            // A cleared binding means "unbound"; the default only stands in for an absent one.
            enabled: isMounted && keyboardShortcuts.commandPalette !== "",
            enableOnContentEditable: true,
            enableOnFormTags: true,
            preventDefault: true,
        },
        [isMounted, keyboardShortcuts.commandPalette, handleCommandPaletteToggle],
    );

    // A read the shown rows depend on that failed, said in place of "No results found.".
    let listFailure: string | undefined;

    if (isMeaningSearchCurrent && isMeaningSearchFailed) {
        // `MEANING_SEARCH_REFUSED` (`agent/thread-search-plan.ts`): the account's model rules refuse the embedding model.
        listFailure =
            errorCode(meaningSearchError) === "MEANING_SEARCH_REFUSED"
                ? t`Search by meaning isn't available under your account's model rules, so related threads are not listed.`
                : t`Search by meaning failed, so related threads are not listed. Try again in a moment.`;
    } else if (projectRowsVisible(scope) && projectFilter === undefined && isProjectListFailed) {
        listFailure = t`Your projects could not be loaded. Try again in a moment.`;
    }

    return (
        <>
            {confirmDialog}
            <DeleteConfirmationDialog
                description={t`Are you sure you want to delete this thread? This action cannot be undone and will permanently remove all messages in this conversation.`}
                onConfirm={() => {
                    const pending = pendingDelete;

                    setPendingDelete(undefined);
                    pending?.run();
                }}
                onOpenChange={(open) => {
                    if (!open) {
                        setPendingDelete(undefined);
                    }
                }}
                open={pendingDelete !== undefined}
                title={t`Delete thread?`}
            />
            <CommandDialog
                onOpenChange={(newOpen) => {
                    setOpen(newOpen);
                }}
                open={isOpen}
            >
                <CommandDialogPopup>
                    <Command filter={filterItem} items={groupedItems} onValueChange={setSearchInput} value={searchInput}>
                        <CommandInput placeholder={t`Search threads, navigate, or perform actions...`} />
                        <div aria-label={t`Filter results`} className="flex flex-wrap items-center gap-1.5 px-3 pt-2" role="group">
                            <Toggle onPressedChange={(pressed) => setScope({ ...scope, threads: pressed })} pressed={scope.threads} size="sm" variant="outline">
                                {t`Threads`}
                            </Toggle>
                            <Toggle
                                onPressedChange={(pressed) => {
                                    setScope({ ...scope, projects: pressed });

                                    // Project rows hide under a chosen project, and the Projects filter hides thread rows: together they list nothing.
                                    if (pressed) {
                                        setProjectFilter(undefined);
                                    }
                                }}
                                pressed={scope.projects}
                                size="sm"
                                variant="outline"
                            >
                                {t`Projects`}
                            </Toggle>
                            <Toggle
                                onPressedChange={(pressed) => setScope({ ...scope, archived: pressed })}
                                pressed={scope.archived}
                                size="sm"
                                variant="outline"
                            >
                                {t`Archived`}
                            </Toggle>
                            {projectFilter !== undefined && (
                                <Toggle onPressedChange={() => setProjectFilter(undefined)} pressed size="sm" variant="outline">
                                    {t`Project: ${projectFilter.title}`}
                                </Toggle>
                            )}
                        </div>
                        <CommandPanel>
                            {/* A state tag, the Archived filter and a chosen project filter the threads loaded here, one page of them: say so when there are more, so an empty or short list is not taken as complete. */}
                            {(stateFilter !== undefined || scope.archived || projectFilter !== undefined) && allThreadsData.hasMore && (
                                <p className="text-muted-foreground px-3 pt-2 text-xs">
                                    {t`Only the ${allThreadsData.lunora.length} threads loaded here are filtered; older ones are not included.`}
                                </p>
                            )}
                            {projectMayMissLocked && (
                                <p className="text-muted-foreground px-3 pt-2 text-xs">{t`Locked chats do not reveal their project, so some may be missing here.`}</p>
                            )}
                            {projectRowsVisible(scope) && projectFilter === undefined && hasMoreProjects && (
                                <p className="text-muted-foreground px-3 pt-2 text-xs">{t`Only the first ${projects.length} projects are listed here.`}</p>
                            )}
                            {/* The archived hits are what is left of the closest matches overall, so archived threads ranked below many active ones can be missing. */}
                            {isMeaningSearchCurrent && scope.archived && !isMeaningSearchFailed && (
                                <p className="text-muted-foreground px-3 pt-2 text-xs">
                                    {t`Related archived threads are picked from the closest matches across all your threads, so some may not be listed.`}
                                </p>
                            )}
                            {/* A failed read is said, so an empty or short list is not taken for "nothing there". */}
                            {listFailure === undefined ? (
                                <CommandEmpty>{t`No results found.`}</CommandEmpty>
                            ) : (
                                <p className="text-destructive px-3 pt-2 text-xs" role="alert">
                                    {listFailure}
                                </p>
                            )}
                            <CommandList>
                                {(group: Group, index: number) => (
                                    <React.Fragment key={group.value}>
                                        <CommandGroup items={group.items}>
                                            <CommandGroupLabel>{group.value}</CommandGroupLabel>
                                            <CommandCollection>
                                                {(item: Item) => (
                                                    <CommandItem key={item.value} onClick={item.onClick} value={item.value}>
                                                        {item.icon}
                                                        <span className={item.isMessageHit ? "ml-2 line-clamp-2 flex-1 break-words" : "ml-2 flex-1"}>
                                                            {item.label}
                                                        </span>
                                                        {item.detail && (
                                                            <CommandShortcut className="max-w-40 truncate tracking-normal">{item.detail}</CommandShortcut>
                                                        )}
                                                        {item.shortcut && <CommandShortcut>{formatShortcutForDisplay(item.shortcut)}</CommandShortcut>}
                                                        {item.isCurrent && <CommandShortcut>{t`Current`}</CommandShortcut>}
                                                        {item.threadId && !isImpersonating && (
                                                            <div className="ml-auto flex gap-1">
                                                                <button
                                                                    aria-label={item.status === "archived" ? t`Unarchive thread` : t`Archive thread`}
                                                                    className="hover:bg-muted rounded p-1"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation();

                                                                        if (updateThread) {
                                                                            updateThread(
                                                                                item.threadId!,
                                                                                currentThreadModel,
                                                                                item.status === "archived" ? "active" : "archived",
                                                                            );
                                                                            close();
                                                                        }
                                                                    }}
                                                                    type="button"
                                                                >
                                                                    {item.status === "archived" ? (
                                                                        <ArchiveRestore className="size-3" />
                                                                    ) : (
                                                                        <Archive className="size-3" />
                                                                    )}
                                                                </button>
                                                                {item.threadId !== "default" && (
                                                                    <button
                                                                        aria-label={t`Delete thread`}
                                                                        className="hover:bg-muted rounded p-1"
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();

                                                                            if (confirmBeforeDelete) {
                                                                                askBeforeDelete(() => {
                                                                                    void handleDeleteThread(item.threadId!);
                                                                                });

                                                                                return;
                                                                            }

                                                                            handleDeleteThread(item.threadId!);
                                                                        }}
                                                                        type="button"
                                                                    >
                                                                        <Trash2 className="size-3" />
                                                                    </button>
                                                                )}
                                                            </div>
                                                        )}
                                                    </CommandItem>
                                                )}
                                            </CommandCollection>
                                        </CommandGroup>
                                        {index < groupedItems.length - 1 && <CommandSeparator />}
                                    </React.Fragment>
                                )}
                            </CommandList>
                        </CommandPanel>
                        <CommandFooter>
                            <div className="flex items-center gap-4">
                                <div className="flex items-center gap-2">
                                    <KbdGroup>
                                        <Kbd>
                                            <ArrowUpIcon />
                                        </Kbd>
                                        <Kbd>
                                            <ArrowDownIcon />
                                        </Kbd>
                                    </KbdGroup>
                                    <span>{t`Navigate`}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <Kbd>
                                        <CornerDownLeftIcon />
                                    </Kbd>
                                    <span>{t`Open`}</span>
                                </div>
                            </div>
                            <div className="flex items-center gap-2">
                                <KbdGroup>
                                    <Kbd>⌘</Kbd>
                                    <Kbd>K</Kbd>
                                </KbdGroup>
                                <span>{t`Close`}</span>
                            </div>
                        </CommandFooter>
                    </Command>
                </CommandDialogPopup>
            </CommandDialog>
        </>
    );
};

const GlobalCommandPalette = () => {
    const isMounted = useIsHydrated();

    if (!isMounted) {
        return null;
    }

    return <GlobalCommandPaletteContent isMounted={isMounted} />;
};

export default GlobalCommandPalette;
