import { useLingui } from "@lingui/react/macro";
import { skipToken, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import { THREAD_LIST_PAGINATION_OPTS } from "@/features/chat/core/constants/query-options";
import { useOptimisticDeletions, useOptimisticPins, useOptimisticStatuses } from "@/features/chat/core/stores/thread-store-hooks";
import { matchesThreadFilters, pruneSelectedTagIds, resolveThreadTags } from "@/features/chat/tags/thread-tag-logic";
import { useProjects } from "@/features/projects/hooks/use-projects";
import { useCRPC, useLunoraAuth } from "@/lib/lunora/crpc";

import { useDateBoundaries } from "../contexts/date-boundaries-context";
import { selectSelectedTagIds, useThreadListUIStore } from "../stores/thread-list-ui-store";
import type { BranchNode, GroupType, MinimalThreadRelationship, ThreadGroup } from "../types";

/**
 * Sorts threads by custom order, then by creation time (newest first).
 * Used for sorting threads within groups (no search relevance).
 */
const sortThreadsInGroup = (threads: BranchNode[]): BranchNode[] => {
    if (threads.length <= 1) {
        return threads;
    }

    return threads.toSorted((a, b) => {
        // Custom order priority
        const aOrder = a.order;
        const bOrder = b.order;

        if (aOrder !== undefined && bOrder !== undefined) {
            return aOrder - bOrder;
        }

        if (aOrder !== undefined) {
            return -1;
        }

        if (bOrder !== undefined) {
            return 1;
        }

        // Then by creation time (newest first)
        return b.createdAt - a.createdAt;
    });
};

const useThreadGroups = (
    collapsedGroups: Set<GroupType>,
    collapsedProjects: Set<string>,
    searchQuery: string,
    searchType: "threads" | "messages",
    selectedCategory: string | undefined,
    threadRelationships: MinimalThreadRelationship[],
    threadSearchResults: any,
    messageSearchResults: any,
) => {
    const crpc = useCRPC();
    const { isAuthenticated, isLoading } = useLunoraAuth();

    // Only run queries when authenticated and not loading
    const isAuthReady = isAuthenticated && !isLoading;

    // Always use composite query (category filtering is done client-side)
    const useCompositeQuery = isAuthReady;

    // Composite query for thread list data (threads + temporary + pinned + orders)
    // This replaces 4 separate queries with 1 query that fetches all in parallel server-side
    const { data: compositeData } = useQuery(
        crpc.chat.composite.getThreadListData.queryOptions(useCompositeQuery ? { paginationOpts: THREAD_LIST_PAGINATION_OPTS } : skipToken),
    );

    // Derive data from composite query
    const threadsData = compositeData?.threads;
    const temporaryThreads = compositeData?.temporaryThreads;
    const pinnedThreads = compositeData?.pinnedThreads;
    const threadOrders = compositeData?.threadOrders;
    // Use relationships from composite query when available, fall back to prop
    const effectiveRelationships = compositeData?.relationships ?? threadRelationships;

    // Tag filter, with ids of since-deleted tags ignored so they cannot hide everything.
    const rawSelectedTagIds = useThreadListUIStore(selectSelectedTagIds);
    const selectedTagIds = useMemo(() => pruneSelectedTagIds(rawSelectedTagIds, compositeData?.tags), [rawSelectedTagIds, compositeData?.tags]);

    const projects = useProjects();
    const { t } = useLingui();

    // Get optimistic state for instant UI updates
    const optimisticPins = useOptimisticPins();
    const optimisticStatuses = useOptimisticStatuses();
    const optimisticDeletions = useOptimisticDeletions();

    // Get date boundaries from context (updates at midnight)
    const dateBoundaries = useDateBoundaries();

    // --- Stage 1: Build lookup maps (only recomputes when raw data changes) ---
    const lookupMaps = useMemo(() => {
        // Determine which threads to use based on search type
        const isSearching = searchQuery.trim().length > 0;
        let threadsToUse;

        if (isSearching && searchType === "threads") {
            threadsToUse = threadSearchResults?.page;
        } else if (isSearching && searchType === "messages") {
            threadsToUse = messageSearchResults?.page;
        } else {
            threadsToUse = threadsData?.page;
        }

        if (!threadsToUse) {
            return null;
        }

        // Create maps for quick lookups
        const temporaryThreadsPage = temporaryThreads?.page || [];
        const allThreadsForMap = threadsToUse.length + temporaryThreadsPage.length > 0 ? [...threadsToUse, ...temporaryThreadsPage] : threadsToUse;

        const threadMap = new Map<string, any>(allThreadsForMap.map((thread: any) => [thread._id, thread]));

        const relationships = effectiveRelationships || [];
        const relationshipMap = new Map<string, MinimalThreadRelationship>(relationships.map((rel: MinimalThreadRelationship) => [rel.threadId, rel]));

        // pinnedThreads returns ThreadDoc objects with _id field, not threadId
        const pinnedThreadsArray = pinnedThreads || [];
        const pinnedThreadsSet = new Set<string>(pinnedThreadsArray.map((pin: any) => pin._id));

        const threadOrdersArray = threadOrders || [];
        const threadOrderMap = new Map<string, number>(threadOrdersArray.map((order: any) => [order.threadId, order.order]));

        // Find root threads (threads without parent relationships)
        const rootThreads = threadsToUse.filter((thread: any) => !relationshipMap.has(thread._id));

        // Build child map once for O(1) lookups instead of filtering each time
        const childrenMap = new Map<string, MinimalThreadRelationship[]>();

        for (const rel of relationships) {
            if (!rel.parentThreadId) {
                continue;
            }

            const existing = childrenMap.get(rel.parentThreadId) || [];

            existing.push(rel);
            childrenMap.set(rel.parentThreadId, existing);
        }

        // Build temporary root threads
        const temporaryRootThreads = temporaryThreadsPage.filter((thread: any) => !relationshipMap.has(thread._id));

        return {
            childrenMap,
            pinnedThreadsSet,
            relationshipMap,
            rootThreads,
            temporaryRootThreads,
            threadMap,
            threadOrderMap,
        };
    }, [
        threadsData?.page,
        temporaryThreads?.page,
        threadSearchResults?.page,
        messageSearchResults?.page,
        effectiveRelationships,
        pinnedThreads,
        threadOrders,
        searchQuery,
        searchType,
    ]);

    // --- Stage 2: Build thread hierarchy trees (only recomputes when maps or optimistic state changes) ---
    const hierarchyData = useMemo(() => {
        if (!lookupMaps) {
            return null;
        }

        const { childrenMap, pinnedThreadsSet, rootThreads, temporaryRootThreads, threadMap, threadOrderMap } = lookupMaps;
        const userTags = compositeData?.tags;

        const buildHierarchy = (threadId: string, depth: number = 0): BranchNode | null => {
            // Skip optimistically deleted threads (instant UI removal)
            if (optimisticDeletions.has(threadId)) {
                return null;
            }

            const thread = threadMap.get(threadId);

            if (!thread) {
                return null;
            }

            // Find direct children using pre-built map
            const childRelationships = childrenMap.get(threadId) || [];
            const children = childRelationships
                .map((rel: MinimalThreadRelationship) => buildHierarchy(rel.threadId, depth + 1))
                .filter((node): node is BranchNode => node !== null);

            // Apply optimistic state overrides (instant UI updates)
            const optimisticPin = optimisticPins.get(threadId);
            const optimisticStatus = optimisticStatuses.get(threadId);

            return {
                branchPoint: 0,
                branchType: "branch",
                category: thread.category,
                children,
                createdAt: thread._creationTime,
                depth,
                expiresAt: thread.expiresAt,
                isPinned: optimisticPin === undefined ? pinnedThreadsSet.has(threadId) : optimisticPin,
                model: thread.model,
                order: threadOrderMap.get(threadId),
                projectId: thread.projectId,
                relevantMessages: thread.relevantMessages,
                source: thread.source,
                statelessMode: thread.statelessMode,
                status: optimisticStatus === undefined ? thread.status || "active" : optimisticStatus,
                tagIds: thread.tagIds,
                tags: resolveThreadTags(thread.tagIds, userTags),
                threadId: thread._id,
                title: thread.title || t`New Chat`,
            };
        };

        const allThreadsList = rootThreads
            .map((thread: any) => buildHierarchy(thread._id))
            .filter((node: BranchNode | null): node is BranchNode => node !== null);

        // Build temporary threads hierarchy separately
        const temporaryThreadsList: BranchNode[] = temporaryRootThreads
            .map((thread: any) => buildHierarchy(thread._id))
            .filter((node: BranchNode | null): node is BranchNode => node !== null && node.expiresAt !== undefined);

        // Single pass: separate threads by type (more efficient than multiple filters)
        // Apply category + tag filters if selected
        const filters = { category: selectedCategory, tagIds: selectedTagIds };
        const statelessThreads: BranchNode[] = [];
        const regularThreads: BranchNode[] = [];

        for (const thread of allThreadsList) {
            if (thread.expiresAt !== undefined) {
                continue;
            }

            // Skip threads that don't match the selected category / tags
            if (!matchesThreadFilters(thread, filters)) {
                continue;
            }

            if (thread.statelessMode === true) {
                statelessThreads.push(thread);
            } else {
                regularThreads.push(thread);
            }
        }

        // Also filter temporary threads
        const filteredTemporaryThreadsList =
            selectedCategory || selectedTagIds.length > 0
                ? temporaryThreadsList.filter((candidate) => matchesThreadFilters(candidate, filters))
                : temporaryThreadsList;

        return {
            allThreadsList,
            regularThreads,
            statelessThreads,
            temporaryThreadsList: filteredTemporaryThreadsList,
        };
    }, [lookupMaps, optimisticPins, optimisticStatuses, optimisticDeletions, selectedCategory, selectedTagIds, compositeData?.tags, t]);

    // --- Stage 3: Sort callback for search results (stable reference) ---
    const sortThreadsByPriority = useCallback(
        (a: BranchNode, b: BranchNode): number => {
            // Message search relevance (only for message search)
            if (searchType === "messages" && messageSearchResults?.page) {
                const aRelevance = a.relevantMessages?.length || 0;
                const bRelevance = b.relevantMessages?.length || 0;

                if (aRelevance !== bRelevance) {
                    return bRelevance - aRelevance; // More relevant first
                }
            }

            // Pinned threads first
            if (a.isPinned !== b.isPinned) {
                return a.isPinned ? -1 : 1;
            }

            // Custom order (if both have order, sort by order; if only one has order, it comes first)
            const aOrder = a.order;
            const bOrder = b.order;

            if (aOrder !== undefined && bOrder !== undefined) {
                return aOrder - bOrder;
            }

            if (aOrder !== undefined) {
                return -1;
            }

            if (bOrder !== undefined) {
                return 1;
            }

            // Finally, sort by creation time (newest first)
            return b.createdAt - a.createdAt;
        },
        [searchType, messageSearchResults?.page],
    );

    // --- Stage 4: Group threads by project using Map (O(n)) ---
    const threadsByProject = useMemo(() => {
        if (!hierarchyData || searchQuery.trim()) {
            return null;
        }

        const { regularThreads } = hierarchyData;
        const projectsMap = new Map<string, any>((projects || []).map((p: any) => [p._id, p]));
        const map = new Map<string, BranchNode[]>();
        const threadsWithoutProject: BranchNode[] = [];

        for (const thread of regularThreads) {
            if (thread.projectId && projectsMap.has(thread.projectId)) {
                const existing = map.get(thread.projectId);

                if (existing) {
                    existing.push(thread);
                } else {
                    map.set(thread.projectId, [thread]);
                }
            } else {
                threadsWithoutProject.push(thread);
            }
        }

        return { map, threadsWithoutProject };
    }, [hierarchyData, projects, searchQuery]);

    // Memoize search results separately - this is a common hot path
    const searchResultsGroup = useMemo(() => {
        if (!searchQuery.trim() || !hierarchyData) {
            return null;
        }

        const { allThreadsList } = hierarchyData;
        const sortedThreads = allThreadsList.toSorted(sortThreadsByPriority);

        return [
            {
                groupType: "older" as GroupType,
                isCollapsed: false,
                threads: sortedThreads,
                title: t`Search Results (${sortedThreads.length})`,
            },
        ] as ThreadGroup[];
    }, [hierarchyData, searchQuery, sortThreadsByPriority, t]);

    // --- Stage 5: Build final thread groups (grouping + collapse state) ---
    const threadGroups = useMemo(() => {
        // Early return for search results
        if (searchResultsGroup) {
            return searchResultsGroup;
        }

        if (!hierarchyData) {
            return [];
        }

        if (!threadsByProject) {
            return [];
        }

        const { statelessThreads, temporaryThreadsList } = hierarchyData;
        const { threadsWithoutProject } = threadsByProject;

        // Group threads by time periods using context date boundaries
        const { sevenDaysAgo, thirtyDaysAgo, today: todayTimestamp } = dateBoundaries;

        // Pre-allocate arrays for grouping
        const pinnedThreadsList: BranchNode[] = [];
        const statelessThreadsList: BranchNode[] = [];
        const todayThreads: BranchNode[] = [];
        const last7DaysThreads: BranchNode[] = [];
        const lastMonthThreads: BranchNode[] = [];
        const olderThreads: BranchNode[] = [];
        const archivedThreads: BranchNode[] = [];

        // Group stateless threads separately (excluding archived)
        for (const thread of statelessThreads) {
            if (thread.status === "archived") {
                archivedThreads.push(thread);
            } else {
                statelessThreadsList.push(thread);
            }
        }

        // Single pass grouping for regular threads without projects
        for (const thread of threadsWithoutProject) {
            if (thread.status === "archived") {
                archivedThreads.push(thread);
            } else if (thread.isPinned) {
                pinnedThreadsList.push(thread);
            } else if (thread.createdAt >= todayTimestamp) {
                todayThreads.push(thread);
            } else if (thread.createdAt >= sevenDaysAgo) {
                last7DaysThreads.push(thread);
            } else if (thread.createdAt >= thirtyDaysAgo) {
                lastMonthThreads.push(thread);
            } else {
                olderThreads.push(thread);
            }
        }

        const groups: ThreadGroup[] = [];

        // Add project groups first (before time-based groups)
        // Include all projects, even if they have no threads
        // Sort projects by order (if set), then by pinnedAt, then by createdAt
        const sortedProjects = projects.toSorted((a: any, b: any) => {
            // First, sort by order if both have it
            if (a.order !== undefined && b.order !== undefined) {
                return a.order - b.order;
            }

            if (a.order !== undefined) {
                return -1;
            }

            if (b.order !== undefined) {
                return 1;
            }

            // Then by pinnedAt (pinned first)
            if (a.pinnedAt !== undefined && b.pinnedAt !== undefined) {
                return b.pinnedAt - a.pinnedAt;
            }

            if (a.pinnedAt !== undefined) {
                return -1;
            }

            if (b.pinnedAt !== undefined) {
                return 1;
            }

            // Finally by creation time (newest first)
            return b.createdAt - a.createdAt;
        });

        for (const project of sortedProjects) {
            const projectId = project._id;
            const projectThreads = threadsByProject.map.get(projectId) || [];

            // Filter out archived threads from project groups
            const activeProjectThreads = projectThreads.filter((candidate) => candidate.status !== "archived");

            // Check if this specific project group is collapsed
            const isCollapsed = collapsedProjects.has(projectId);

            groups.push({
                groupType: "project" as GroupType,
                isCollapsed,
                projectColor: project.color,
                projectIcon: project.icon,
                projectId,
                threads: sortThreadsInGroup(activeProjectThreads),
                title: project.title,
            });
        }

        // Build groups array efficiently from configured group types
        const groupConfigs: {
            groupType: GroupType;
            threads: BranchNode[];
            title: string;
        }[] = [
            { groupType: "temporary", threads: temporaryThreadsList, title: t`Temporary` },
            { groupType: "pinned", threads: pinnedThreadsList, title: t`Pinned` },
            { groupType: "stateless", threads: statelessThreadsList, title: t`Stateless` },
            { groupType: "today", threads: todayThreads, title: t`Today` },
            { groupType: "last7days", threads: last7DaysThreads, title: t`Last 7 days` },
            { groupType: "lastMonth", threads: lastMonthThreads, title: t`Last month` },
            { groupType: "older", threads: olderThreads, title: t`Older` },
            { groupType: "archived", threads: archivedThreads, title: t`Archived` },
        ];

        for (const config of groupConfigs) {
            if (config.threads.length > 0) {
                groups.push({
                    groupType: config.groupType,
                    isCollapsed: collapsedGroups.has(config.groupType),
                    threads: sortThreadsInGroup(config.threads),
                    title: config.title,
                });
            }
        }

        return groups;
    }, [searchResultsGroup, hierarchyData, threadsByProject, projects, collapsedGroups, collapsedProjects, dateBoundaries, t]);

    return { threadGroups, threadsData };
};

export default useThreadGroups;
