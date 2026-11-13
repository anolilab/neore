import { LUNORA_ID_SOURCE } from "@neore/client-runtime";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useAuthActiveOrganization } from "@/features/auth/hooks/use-auth-session";
import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import ManageThreadTagsDialog from "@/features/chat/tags/manage-thread-tags-dialog";
import useDebouncedValue from "@/hooks/use-debounced-value";
import { useHasOpened } from "@/hooks/use-has-opened";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { DateBoundariesProvider } from "./contexts/date-boundaries-context";
import HierarchicalThreadList from "./hierarchical-thread-list";
import usePersistedCollapseState from "./hooks/use-persisted-collapse-state";
import { useThreadListPlaceholder } from "./hooks/use-thread-list-cache";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";
import type { GroupType, LoadingStates } from "./types";

// Lazy: it pulls `lucide-react/dynamic`'s import map of every icon (~190KB) for its icon picker.
const ProjectFormDialog = lazy(() => import("@/features/projects/components/project-form-dialog"));

const CHAT_THREAD_PATH_RE = new RegExp(`^/chat/(${LUNORA_ID_SOURCE})$`);

/** How long typing pauses before the sidebar searches: one query per pause, not one per keystroke. */
const SEARCH_DEBOUNCE_MS = 250;

/** A cleared search box clears the search at once; typing again starts a fresh pause. */
const isClearedQuery = (query: string): boolean => query === "";

/** The search answer the list shows, with the search it answers: its query, its type and the organization it was asked in. */
interface ShownAnswer {
    data: unknown;
    organizationId: string | null;
    query: string;
    type: "threads" | "messages";
}

const sameMembers = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean =>
    left.size === right.size && [...left].every((member) => right.has(member));

const ThreadList: FC = () => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading: isAuthLoading } = useLunoraAuth();
    const { data: activeOrganization } = useAuthActiveOrganization();
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
    const setShowKeyboardHelp = useThreadListUIStore((state) => state.setShowKeyboardHelp);
    const setSelectedThreadIds = useThreadListUIStore((state) => state.setSelectedThreadIds);
    const setLastSelectedIndex = useThreadListUIStore((state) => state.setLastSelectedIndex);
    const exitSelectionMode = useThreadListUIStore((state) => state.exitSelectionMode);
    const closeProjectFormDialog = useThreadListUIStore((state) => state.closeProjectFormDialog);
    // Mounted on first open only: a lazy dialog rendered closed still loads its chunk on first paint.
    const hasOpenedProjectForm = useHasOpened(showProjectFormDialog);
    const showManageTagsDialog = useThreadListUIStore((state) => state.showManageTagsDialog);
    const setShowManageTagsDialog = useThreadListUIStore((state) => state.setShowManageTagsDialog);

    // The box shows every keystroke; the server is asked once typing pauses.
    // An EMPTY query must not run: it used to fire on every first paint of
    // /chat (the default type is "threads"), for results nothing shows.
    const typedQuery = searchQuery.trim();
    // A cleared box clears at once, and its pending query with it: the full list must not wait for the pause.
    const askedQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS, isClearedQuery);

    const threadSearch = useQuery(
        crpc.chat.functions.searchThreads.queryOptions(
            askedQuery !== "" && searchType === "threads"
                ? {
                      organizationId,
                      paginationOpts: THREAD_LIST_PAGINATION_OPTS,
                      searchQuery: askedQuery,
                  }
                : skipToken,
        ),
    );

    const messageSearch = useQuery(
        crpc.chat.functions.searchMessages.queryOptions(
            askedQuery !== "" && searchType === "messages"
                ? {
                      paginationOpts: THREAD_LIST_PAGINATION_OPTS,
                      searchQuery: askedQuery,
                  }
                : skipToken,
        ),
    );

    // Each answer stays on screen, with the search it answers, until the next one arrives: the list never empties while a new
    // query runs, and rows and their match snippets always come from the same query. Adjusted during render, as `previousInputs`
    // below, so the answer and the list change together.
    const askedSearch = searchType === "threads" ? threadSearch : messageSearch;
    const [shownAnswer, setShownAnswer] = useState<ShownAnswer | null>(null);

    if (typedQuery === "") {
        // A cleared box forgets the answer: typing again shows every thread until the new query's own answer arrives.
        if (shownAnswer !== null) {
            setShownAnswer(null);
        }
    } else if (askedQuery !== "" && askedSearch.data !== undefined && askedSearch.data !== shownAnswer?.data) {
        setShownAnswer({ data: askedSearch.data, organizationId, query: askedQuery, type: searchType });
    }

    // An answer for another search type or another organization is never shown: until this one's first answer, every thread is.
    const visibleAnswer =
        typedQuery !== "" && shownAnswer !== null && shownAnswer.type === searchType && shownAnswer.organizationId === organizationId ? shownAnswer : null;
    // A search that failed shows that it failed, not the full list as if no search ran.
    const isSearchError = typedQuery !== "" && askedQuery !== "" && askedSearch.isError;
    const shownQuery = isSearchError ? askedQuery : (visibleAnswer?.query ?? "");
    const threadSearchResults = !isSearchError && visibleAnswer?.type === "threads" ? visibleAnswer.data : undefined;
    const messageSearchResults = !isSearchError && visibleAnswer?.type === "messages" ? visibleAnswer.data : undefined;

    // Get current thread ID from URL
    const location = useLocation();
    const currentThreadId = location.pathname.match(CHAT_THREAD_PATH_RE)?.[1];

    // Use composite query for relationships (shares cache with useThreadGroups, eliminates standalone subscription)
    // The stored copy answers here too, so a reload on a child thread expands its ancestors before the first answer.
    const storedThreadList = useThreadListPlaceholder();
    const { data: threadRelationships } = useQuery({
        ...crpc.chat.composite.getThreadListData.queryOptions(isAuthReady ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken),
        placeholderData: storedThreadList as never,
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

            // The same ancestors keep the same set: a new one would re-render every row for nothing.
            setExpandedThreads((previous) => (sameMembers(previous, ancestors) ? previous : ancestors));
        }
    }

    // Searching while typing has not paused yet, or while the asked query's answer is on its way.
    const isSearchLoading = typedQuery !== "" && (typedQuery !== askedQuery || askedSearch.isFetching);

    // Every row gets this: one function for the list's whole life.
    const toggleExpanded = useCallback((threadId: string) => {
        setExpandedThreads((previous) => {
            const next = new Set(previous);

            if (next.has(threadId)) {
                next.delete(threadId);
            } else {
                next.add(threadId);
            }

            return next;
        });
    }, []);

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
                    isSearchError={isSearchError}
                    isSearchLoading={isSearchLoading}
                    isSelectionMode={isSelectionMode}
                    lastSelectedIndex={lastSelectedIndex}
                    loadingStates={loadingStates}
                    messageSearchResults={messageSearchResults}
                    onExitSelectionMode={exitSelectionMode}
                    searchQuery={shownQuery}
                    searchType={searchType}
                    selectedCategory={selectedCategory}
                    selectedThreadIds={selectedThreadIds}
                    setLastSelectedIndex={setLastSelectedIndex}
                    setLoadingStates={setLoadingStates}
                    setSelectedThreadIds={setSelectedThreadIds}
                    setShowKeyboardHelp={setShowKeyboardHelp}
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
