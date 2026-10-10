import { skipToken, useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import type { FC } from "react";
import { lazy, Suspense, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import ManageThreadTagsDialog from "@/features/chat/tags/manage-thread-tags-dialog";
import { useHasOpened } from "@/hooks/use-has-opened";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";
import { LUNORA_ID_SOURCE } from "@/lib/lunora/ids";

import { DateBoundariesProvider } from "./contexts/date-boundaries-context";
import HierarchicalThreadList from "./hierarchical-thread-list";
import usePersistedCollapseState from "./hooks/use-persisted-collapse-state";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";
import type { GroupType, LoadingStates } from "./types";

// Lazy: it pulls `lucide-react/dynamic`'s import map of every icon (~190KB) for its icon picker.
const ProjectFormDialog = lazy(() => import("@/features/projects/components/project-form-dialog"));

const CHAT_THREAD_PATH_RE = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

const ThreadList: FC = () => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();
    const { hooks } = useAuth();
    const { data: activeOrganization } = hooks.useActiveOrganization();
    const organizationId = activeOrganization?.id ?? null;
    const isAuthReady = isAuthenticated && !isAuthLoading;
    const [expandedThreads, setExpandedThreads] = useState<Set<string>>(() => new Set());
    const { collapsedGroups, collapsedProjects, setCollapsedGroups, setCollapsedProjects } = usePersistedCollapseState();
    const [loadingStates, setLoadingStates] = useState<LoadingStates>(() => {
        return {
            archiving: new Set(),
            branching: new Set(),
            deleting: new Set(),
            downloading: new Set(),
            pinning: new Set(),
            reordering: false,
        };
    });

    // Get shared UI state from store - state values with shallow comparison
    const {
        editingProject,
        isSelectionMode,
        lastSelectedIndex,
        searchQuery,
        searchType,
        selectedCategory,
        selectedThreadIds,
        showKeyboardHelp,
        showProjectFormDialog,
    } = useThreadListUIStore(
        useShallow((state) => {
            return {
                editingProject: state.editingProject,
                isSelectionMode: state.isSelectionMode,
                lastSelectedIndex: state.lastSelectedIndex,
                searchQuery: state.searchQuery,
                searchType: state.searchType,
                selectedCategory: state.selectedCategory,
                selectedThreadIds: state.selectedThreadIds,
                showKeyboardHelp: state.showKeyboardHelp,
                showProjectFormDialog: state.showProjectFormDialog,
            };
        }),
    );

    // Get actions directly from store (stable references, no need for shallow comparison)
    const setShowSearch = useThreadListUIStore((state) => state.setShowSearch);
    const setShowKeyboardHelp = useThreadListUIStore((state) => state.setShowKeyboardHelp);
    const setSelectedThreadIds = useThreadListUIStore((state) => state.setSelectedThreadIds);
    const setLastSelectedIndex = useThreadListUIStore((state) => state.setLastSelectedIndex);
    const exitSelectionMode = useThreadListUIStore((state) => state.exitSelectionMode);
    const closeProjectFormDialog = useThreadListUIStore((state) => state.closeProjectFormDialog);
    // Mounted on first open only: a lazy dialog rendered closed still loads its chunk on first paint.
    const hasOpenedProjectForm = useHasOpened(showProjectFormDialog);
    const showManageTagsDialog = useThreadListUIStore((state) => state.showManageTagsDialog);
    const setShowManageTagsDialog = useThreadListUIStore((state) => state.setShowManageTagsDialog);

    // Search threads when there's a search query and search type is "threads".
    // An EMPTY query must not run: it used to fire on every first paint of
    // /chat (the default type is "threads"), for results nothing shows.
    const hasSearchQuery = searchQuery.trim() !== "";
    const { data: threadSearchResults } = useQuery(
        crpc.chat.functions.searchThreads.queryOptions(
            hasSearchQuery && searchType === "threads"
                ? {
                      organizationId,
                      paginationOpts: THREAD_LIST_PAGINATION_OPTS,
                      searchQuery: searchQuery.trim(),
                  }
                : skipToken,
        ),
    );

    // Search messages when there's a search query and search type is "messages"
    const { data: messageSearchResults } = useQuery(
        crpc.chat.functions.searchMessages.queryOptions(
            hasSearchQuery && searchType === "messages"
                ? {
                      paginationOpts: THREAD_LIST_PAGINATION_OPTS,
                      searchQuery: searchQuery.trim(),
                  }
                : skipToken,
        ),
    );

    // Get current thread ID from URL
    const location = useLocation();
    const currentThreadId = location.pathname.match(CHAT_THREAD_PATH_RE)?.[1];

    // Use composite query for relationships (shares cache with useThreadGroups, eliminates standalone subscription)
    const { data: threadRelationships } = useQuery({
        ...crpc.chat.composite.getThreadListData.queryOptions(isAuthReady ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken),
        select: (data) => data?.relationships ?? [],
    });

    // Auto-expand parent chain of selected thread
    // The expanded set is derived from the current thread and the relationship
    // table, so it is adjusted during render rather than in an effect — the tree
    // never paints once with the previous thread's ancestors expanded.
    const [previousInputs, setPreviousInputs] = useState<{ currentThreadId: typeof currentThreadId; threadRelationships: typeof threadRelationships }>();

    if (!previousInputs || currentThreadId !== previousInputs.currentThreadId || threadRelationships !== previousInputs.threadRelationships) {
        setPreviousInputs({ currentThreadId, threadRelationships });

        if (currentThreadId && threadRelationships) {
            // Build a map: threadId -> parentThreadId
            const parentMap = new Map<string, string>();

            for (const rel of threadRelationships) {
                if (rel.threadId && rel.parentThreadId) {
                    parentMap.set(rel.threadId, rel.parentThreadId);
                }
            }

            // Walk up the parent chain from currentThreadId
            const ancestors = new Set<string>();
            let cursor = currentThreadId;

            while (parentMap.has(cursor)) {
                const parent = parentMap.get(cursor);

                if (!parent) {
                    break;
                }

                ancestors.add(parent);
                cursor = parent;
            }

            setExpandedThreads(ancestors);
        }
    }

    // Check if search is loading
    const isSearchLoading = Boolean(
        searchQuery.trim() && ((searchType === "threads" && !threadSearchResults) || (searchType === "messages" && !messageSearchResults)),
    );

    const toggleExpanded = (threadId: string) => {
        setExpandedThreads((previous) => {
            const next = new Set(previous);

            if (next.has(threadId)) {
                next.delete(threadId);
            } else {
                next.add(threadId);
            }

            return next;
        });
    };

    const toggleGroupCollapsed = (groupType: GroupType, projectId?: string) => {
        if (groupType === "project" && projectId) {
            // Handle project groups individually
            setCollapsedProjects((previous) => {
                const next = new Set(previous);

                if (next.has(projectId)) {
                    next.delete(projectId);
                } else {
                    next.add(projectId);
                }

                return next;
            });
        } else {
            setCollapsedGroups((previous) => {
                const next = new Set(previous);

                if (next.has(groupType)) {
                    next.delete(groupType);
                } else {
                    next.add(groupType);
                }

                return next;
            });
        }
    };

    return (
        <DateBoundariesProvider>
            <div className="text-brand-black dark:text-brand-white flex flex-col items-stretch gap-1.5">
                <HierarchicalThreadList
                    collapsedGroups={collapsedGroups}
                    collapsedProjects={collapsedProjects}
                    currentThreadId={currentThreadId}
                    expandedThreads={expandedThreads}
                    isSearchLoading={isSearchLoading}
                    isSelectionMode={isSelectionMode}
                    lastSelectedIndex={lastSelectedIndex}
                    loadingStates={loadingStates}
                    messageSearchResults={messageSearchResults}
                    onExitSelectionMode={exitSelectionMode}
                    searchQuery={searchQuery}
                    searchType={searchType}
                    selectedCategory={selectedCategory}
                    selectedThreadIds={selectedThreadIds}
                    setLastSelectedIndex={setLastSelectedIndex}
                    setLoadingStates={setLoadingStates}
                    setSelectedThreadIds={setSelectedThreadIds}
                    setShowKeyboardHelp={setShowKeyboardHelp}
                    setShowSearch={setShowSearch}
                    showKeyboardHelp={showKeyboardHelp}
                    threadRelationships={threadRelationships ?? []}
                    threadSearchResults={threadSearchResults}
                    toggleExpanded={toggleExpanded}
                    toggleGroupCollapsed={toggleGroupCollapsed}
                />
                {hasOpenedProjectForm && (
                    <Suspense fallback={null}>
                        <ProjectFormDialog editingProject={editingProject} onClose={closeProjectFormDialog} open={showProjectFormDialog} />
                    </Suspense>
                )}
                <ManageThreadTagsDialog onOpenChange={setShowManageTagsDialog} open={showManageTagsDialog} />
            </div>
        </DateBoundariesProvider>
    );
};

export default ThreadList;
