import { closestCorners, DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Trash2, X } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, memo, startTransition, Suspense, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { PullRequestCountsProvider } from "@/features/develop/components/pull-request-counts";
import {
    useDeleteProject,
    useMoveThreadToProject,
    usePinProject,
    useProjects,
    useUnpinProject,
    useUpdateProjectOrder,
} from "@/features/projects/hooks/use-projects";
import { useHasOpened } from "@/hooks/use-has-opened";
import { useCRPC } from "@/lib/lunora/crpc";
import settle from "@/lib/settle";
import { showError, showInfo } from "@/lib/toast";

import applyDragEnd from "./apply-drag-end";
import ThreadGroupRenderer from "./components/thread-group-renderer";
import { KeyboardSelectionProvider } from "./contexts/keyboard-selection-context";
import { SearchQueryContext } from "./contexts/search-query-context";
import GroupHeader from "./group-header";
import useKeyboardNavigation from "./hooks/use-keyboard-navigation";
import useStableCallback from "./hooks/use-stable-callback";
import useThreadGroups from "./hooks/use-thread-groups";
import useThreadHandlers from "./hooks/use-thread-handlers";
import useThreadListKeyboard from "./hooks/use-thread-list-keyboard";
import { renameFocusTarget } from "./rename-focus-target";
import RenameThreadDialog from "./rename-thread-dialog";
import SnoozeUntilDialog from "./snooze-until-dialog";
import SortableThreadItem from "./sortable-thread-item";
import { useThreadListUIStore } from "./stores/thread-list-ui-store";
import { isThreadLocked } from "./thread-lock";
import type { BranchNode, GroupType, HierarchicalThreadListProperties, MinimalThreadRelationship, ThreadGroup } from "./types";
import type { ThreadDateRange } from "./utilities";
import { getGroupType, isDragBlocked, isGroupFullySelected, selectThreadIdsByDate } from "./utilities";

// Lazy: it pulls `lucide-react/dynamic`'s import map of every icon (~190KB) for its icon picker.
const ProjectFormDialog = lazy(() => import("@/features/projects/components/project-form-dialog"));

// ============================================================================
// Inlined Components (previously separate files)
// ============================================================================

// SelectionToolbar - Toolbar for bulk thread operations
const SelectionToolbar: FC<{
    isAllSelected: boolean;
    onClearSelection: () => void;
    onDeleteSelected: () => void;
    onDone: () => void;
    onSelectAll: () => void;
    onSelectByDate: (range: ThreadDateRange) => void;
    selectedCount: number;
}> = memo(({ isAllSelected, onClearSelection, onDeleteSelected, onDone, onSelectAll, onSelectByDate, selectedCount }) => {
    const { t } = useLingui();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [isDateRangeOpen, setIsDateRangeOpen] = useState(false);
    const [dateRange, setDateRange] = useState<ThreadDateRange>({ from: "", to: "" });
    const hasDateRange = dateRange.from !== "" || dateRange.to !== "";
    const dateFromId = useId();
    const dateToId = useId();

    const handleDeleteClick = () => setShowDeleteDialog(true);
    const handleConfirmDelete = () => {
        onDeleteSelected();
        setShowDeleteDialog(false);
    };

    return (
        <>
            <div className="bg-sidebar-accent text-brand-black dark:text-brand-white flex items-center justify-between gap-2 rounded-lg px-3 py-2">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                        <Plural one="# thread selected" other="# threads selected" value={selectedCount} />
                    </span>
                    <Button className="h-6 px-2 text-xs" onClick={onSelectAll} size="sm" variant="ghost">
                        {isAllSelected ? t`Deselect all` : t`Select all`}
                    </Button>
                    {selectedCount > 0 && (
                        <Button className="h-6 px-2 text-xs" onClick={onClearSelection} size="sm" variant="ghost">
                            {t`Clear`}
                        </Button>
                    )}
                </div>
                <div className="flex items-center gap-2">
                    <Button
                        aria-expanded={isDateRangeOpen}
                        className="h-6 px-2 text-xs"
                        onClick={() => setIsDateRangeOpen((open) => !open)}
                        size="sm"
                        variant="ghost"
                    >
                        {t`Select by date`}
                    </Button>
                    {selectedCount > 0 && (
                        <Button className="text-destructive hover:bg-destructive/20 h-6 px-2 text-xs" onClick={handleDeleteClick} size="sm" variant="ghost">
                            <Trash2 className="mr-1 h-3 w-3" />
                            {t`Delete`}
                        </Button>
                    )}
                    <Button className="h-6 px-2 text-xs" onClick={onDone} size="sm" variant="ghost">
                        <X className="mr-1 h-3 w-3" />
                        {t`Done`}
                    </Button>
                </div>
            </div>
            {isDateRangeOpen && (
                <div
                    aria-label={t`Select threads active in a date range`}
                    className="bg-sidebar-accent text-brand-black dark:text-brand-white flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs"
                    id="select-by-date-range"
                    role="group"
                >
                    <div className="flex items-center gap-1">
                        <label htmlFor={dateFromId}>{t`From`}</label>
                        <input
                            className="bg-background rounded border px-1.5 py-0.5"
                            id={dateFromId}
                            max={dateRange.to || undefined}
                            onChange={(event) =>
                                setDateRange((previous) => {
                                    return { ...previous, from: event.target.value };
                                })
                            }
                            type="date"
                            value={dateRange.from}
                        />
                    </div>
                    <div className="flex items-center gap-1">
                        <label htmlFor={dateToId}>{t`To`}</label>
                        <input
                            className="bg-background rounded border px-1.5 py-0.5"
                            id={dateToId}
                            min={dateRange.from || undefined}
                            onChange={(event) =>
                                setDateRange((previous) => {
                                    return { ...previous, to: event.target.value };
                                })
                            }
                            type="date"
                            value={dateRange.to}
                        />
                    </div>
                    <Button className="h-6 px-2 text-xs" disabled={!hasDateRange} onClick={() => onSelectByDate(dateRange)} size="sm" variant="ghost">
                        {t`Select matching`}
                    </Button>
                </div>
            )}
            <DeleteConfirmationDialog
                description={t`Are you sure you want to delete ${plural(selectedCount, { one: "# thread", other: "# threads" })}? This action cannot be undone and will permanently remove all messages in these conversations.`}
                onConfirm={handleConfirmDelete}
                onOpenChange={setShowDeleteDialog}
                open={showDeleteDialog}
                title={t`Delete Threads`}
            />
        </>
    );
});

// SortableProjectGroup - Wrapper for drag-sortable project groups
const SortableProjectGroup: FC<{ children: (listeners: any) => ReactNode; projectId: string }> = ({ children, projectId }) => {
    const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id: `project-group-${projectId}` });

    const style = {
        opacity: isDragging ? 0.5 : 1,
        transform: CSS.Transform.toString(transform),
        transition,
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes}>
            {children(listeners)}
        </div>
    );
};

// ============================================================================
// Main Components
// ============================================================================

// Separate component for virtualized rendering to isolate useVirtualizer from React Compiler
// This allows the main component to be optimized while keeping virtualization working
// Component to make project groups droppable
const ProjectGroupContainer: FC<{ children: ReactNode; isProjectGroup: boolean; projectId?: string }> = ({ children, isProjectGroup, projectId }) => {
    const fallbackId = useId();
    const { isOver, setNodeRef } = useDroppable({
        data: {
            projectId,
            type: "project-container",
        },
        disabled: !isProjectGroup,
        id: isProjectGroup && projectId ? `project-${projectId}` : `no-project-${fallbackId}`,
    });

    if (!isProjectGroup) {
        return <div className="space-y-1">{children}</div>;
    }

    return (
        <div
            className={`space-y-1 transition-colors ${isOver ? "bg-accent/30 ring-accent rounded-md ring-2" : ""}`}
            ref={setNodeRef}
            style={{ minHeight: "40px", position: "relative" }}
        >
            {children}
        </div>
    );
};

/** One object for the list's life: new sensor options make new activators, and the drag context then re-renders every sortable row. */
const KEYBOARD_SENSOR_OPTIONS = { coordinateGetter: sortableKeyboardCoordinates };

const VirtualizedThreadList: FC<{
    expandedThreads: Set<string>;
    flattenedThreads: BranchNode[];
    getGroupThreadIds: (group: ThreadGroup) => string[];
    handleCreateBranch: (threadId: string) => void;
    handleDeleteProject: (projectId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handleEditProject: (projectId: string) => void;
    handleGroupToggle: (group: ThreadGroup, e: React.MouseEvent) => void;
    handleMouseEnter: () => void;
    handlePinProject: (projectId: string, isPinned: boolean) => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    isSelectionMode: boolean;
    loadingStates: any;
    projectsMap: Map<string, any>;
    selectedThreadIds: Set<string>;
    toggleExpanded: (threadId: string) => void;
    toggleGroupCollapsed: (groupType: GroupType, projectId?: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
    virtualItems: ({ group: ThreadGroup; groupType: GroupType; type: "group" } | { index: number; thread: BranchNode; type: "thread" })[];
}> = memo(({ virtualItems, ...props }) => {
    const parentReference = useRef<HTMLDivElement>(null);
    const { t } = useLingui();

    // Memoize estimateSize callback
    const estimateSize = useCallback(
        (index: number) => {
            const item = virtualItems[index];

            return item?.type === "group" ? 32 : 44;
        },
        [virtualItems],
    );

    // Memoize getScrollElement callback
    const getScrollElement = useCallback(() => parentReference.current, []);

    // Memoize virtualizer options
    const virtualizerOptions = useMemo(() => {
        return {
            count: virtualItems.length,
            estimateSize,
            getScrollElement,
            overscan: 10,
        };
    }, [virtualItems.length, estimateSize, getScrollElement]);

    // useVirtualizer is incompatible with React Compiler, but isolated in this component
    const virtualizer = useVirtualizer(virtualizerOptions);

    return (
        <div
            className="h-full overflow-auto"
            ref={parentReference}
            style={{
                height: "100%",
                width: "100%",
            }}
        >
            <div
                style={{
                    height: `${virtualizer.getTotalSize()}px`,
                    position: "relative",
                    width: "100%",
                }}
            >
                {virtualizer.getVirtualItems().map((virtualItem) => {
                    const item = virtualItems[virtualItem.index];

                    if (!item) {
                        return null;
                    }

                    return (
                        <div
                            key={virtualItem.key}
                            style={{
                                height: `${virtualItem.size}px`,
                                left: 0,
                                position: "absolute",
                                top: 0,
                                transform: `translateY(${virtualItem.start}px)`,
                                width: "100%",
                            }}
                        >
                            {item.type === "group" ? (
                                (() => {
                                    const project = item.group.projectId ? props.projectsMap.get(item.group.projectId) : null;
                                    const isProjectGroup = item.groupType === "project" && Boolean(item.group.projectId);

                                    return (
                                        <ProjectGroupContainer isProjectGroup={isProjectGroup} projectId={item.group.projectId}>
                                            <GroupHeader
                                                group={item.group}
                                                groupThreadIds={props.getGroupThreadIds(item.group)}
                                                isCollapsed={item.group.isCollapsed ?? false}
                                                isSelectionMode={props.isSelectionMode}
                                                onDeleteProject={props.handleDeleteProject}
                                                onEditProject={props.handleEditProject}
                                                onPinProject={props.handlePinProject}
                                                onToggleCollapse={() => {
                                                    if (!props.isSelectionMode) {
                                                        props.toggleGroupCollapsed(item.groupType, item.group.projectId);
                                                    }
                                                }}
                                                onToggleSelection={(e) => props.handleGroupToggle(item.group, e)}
                                                projectPinnedAt={project?.pinnedAt}
                                                selectedThreadIds={props.selectedThreadIds}
                                            />
                                            {!item.group.isCollapsed && item.group.threads.length === 0 && item.group.projectId && (
                                                <div className="text-muted-foreground px-2 py-4 text-center text-xs">
                                                    {t`Drop threads here to add them to this project`}
                                                </div>
                                            )}
                                        </ProjectGroupContainer>
                                    );
                                })()
                            ) : (
                                <SortableThreadItem
                                    expandedThreads={props.expandedThreads}
                                    handleCreateBranch={props.handleCreateBranch}
                                    handleDeleteThread={props.handleDeleteThread}
                                    handleDownloadThread={props.handleDownloadThread}
                                    handleMouseEnter={props.handleMouseEnter}
                                    handlePinThread={props.handlePinThread}
                                    handleThreadToggle={props.handleThreadToggle}
                                    handleUnpinThread={props.handleUnpinThread}
                                    index={item.index}
                                    isSelected={props.selectedThreadIds.has(item.thread.threadId)}
                                    isSelectionMode={props.isSelectionMode}
                                    key={item.thread.threadId}
                                    loadingStates={props.loadingStates}
                                    node={item.thread}
                                    selectedThreadIds={props.selectedThreadIds}
                                    toggleExpanded={props.toggleExpanded}
                                    updateThread={props.updateThread}
                                />
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
});

VirtualizedThreadList.displayName = "VirtualizedThreadList";

const HierarchicalThreadList: FC<
    HierarchicalThreadListProperties & { currentThreadId: string | undefined; threadRelationships: MinimalThreadRelationship[] }
> = ({
    collapsedGroups,
    collapsedProjects,
    currentThreadId,
    expandedThreads,
    isSearchError = false,
    isSearchLoading,
    isSelectionMode,
    lastSelectedIndex,
    loadingStates,
    messageSearchResults,
    onExitSelectionMode,
    searchQuery,
    searchType,
    selectedCategory,
    selectedThreadIds,
    setLastSelectedIndex,
    setLoadingStates,
    setSelectedThreadIds,
    setShowKeyboardHelp,
    threadRelationships,
    threadSearchResults,
    toggleExpanded,
    toggleGroupCollapsed,
}) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { mutateAsync: updateThreadOrderMutation } = useMutation(crpc.chat.functions.updateThreadOrder.mutationOptions());
    const [editingProject, setEditingProject] = useState<{
        _id: string;
        color?: string;
        context?: string;
        defaultEnabledFeatures?: string[];
        defaultModel?: string;
        defaultReasoningEffort?: number;
        description?: string;
        icon?: string;
        title: string;
    } | null>(null);
    const [showProjectFormDialog, setShowProjectFormDialog] = useState(false);
    // Mounted on first open only: a lazy dialog rendered closed still loads its chunk on first paint.
    const hasOpenedProjectForm = useHasOpened(showProjectFormDialog);
    const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string } | null>(null);
    const [isDeletingProject, setIsDeletingProject] = useState(false);

    const projects = useProjects();
    const { mutateAsync: deleteProject } = useDeleteProject();
    const { mutateAsync: pinProject } = usePinProject();
    const { mutateAsync: unpinProject } = useUnpinProject();
    const { mutateAsync: moveThreadToProject } = useMoveThreadToProject();
    const { mutateAsync: updateProjectOrderMutation } = useUpdateProjectOrder();

    const threadHandlers = useThreadHandlers(setLoadingStates, currentThreadId);
    const { handleBulkDeleteThreads } = threadHandlers;
    // Every row gets these: kept stable, so their closures changing (with the open thread, or the thread data) re-renders no row.
    const handleCreateBranch = useStableCallback(threadHandlers.handleCreateBranch);
    const handleDeleteThread = useStableCallback(threadHandlers.handleDeleteThread);
    const handleDownloadThread = useStableCallback(threadHandlers.handleDownloadThread);
    const handlePinThread = useStableCallback(threadHandlers.handlePinThread);
    const handleUnpinThread = useStableCallback(threadHandlers.handleUnpinThread);
    const updateThread = useStableCallback(threadHandlers.updateThread);

    const { isPlaceholderData, threadGroups, threadsData } = useThreadGroups(
        collapsedGroups,
        collapsedProjects,
        searchQuery,
        searchType,
        selectedCategory,
        threadRelationships,
        threadSearchResults,
        messageSearchResults,
    );

    // Create a map of projectId to project data for quick lookup
    const projectsMap = useMemo(() => {
        const map = new Map();

        (projects || []).forEach((project: any) => {
            map.set(project._id, project);
        });

        return map;
    }, [projects]);

    const handleEditProject = useCallback(
        (projectId: string) => {
            const project = projectsMap.get(projectId);

            if (project) {
                setEditingProject(project);
                setShowProjectFormDialog(true);
            }
        },
        [projectsMap],
    );

    const handleDeleteProject = useCallback(
        (projectId: string) => {
            const project = projectsMap.get(projectId);

            if (project) {
                setProjectToDelete({ id: projectId, name: project.title });
            }
        },
        [projectsMap],
    );

    const handleConfirmDeleteProject = useCallback(async () => {
        if (!projectToDelete) {
            return;
        }

        setIsDeletingProject(true);

        await settle(
            async () => {
                try {
                    // Ids in this component travel as plain strings (dnd-kit `active.id`/`over.id`,
                    // `BranchNode`/`ThreadGroup` fields, local dialog state) but always originate
                    // from documents returned by the backend, so the brand is re-applied here.
                    await deleteProject({ projectId: projectToDelete.id as Id<"projects"> });
                    setProjectToDelete(null);
                } catch (error) {
                    console.error("Failed to delete project:", error);
                    showError(t`Failed to delete project`);
                }
            },
            () => setIsDeletingProject(false),
        );
    }, [deleteProject, projectToDelete, t]);

    const handlePinProject = useCallback(
        async (projectId: string, isPinned: boolean) => {
            // Chosen outside the `try`: the React Compiler cannot lower a conditional inside one.
            const togglePin = isPinned ? unpinProject : pinProject;

            try {
                await togglePin({ projectId: projectId as Id<"projects"> });
            } catch (error) {
                console.error("Failed to pin/unpin project:", error);
            }
        },
        [pinProject, unpinProject],
    );

    // Convert Set to sorted array for stable memoization
    const expandedThreadsArray = useMemo(() => [...expandedThreads].toSorted((a, b) => a.localeCompare(b)), [expandedThreads]);

    // Get all visible thread IDs for selection
    const visibleNodes = useMemo(() => {
        const visible: BranchNode[] = [];
        const expandedSet = new Set(expandedThreadsArray); // Reconstruct Set from array

        const collectNodes = (node: BranchNode) => {
            visible.push(node);

            if (expandedSet.has(node.threadId)) {
                node.children.forEach((child) => collectNodes(child));
            }
        };

        threadGroups.forEach((group) => {
            if (!group.isCollapsed) {
                group.threads.forEach((thread) => collectNodes(thread));
            }
        });

        return visible;
    }, [threadGroups, expandedThreadsArray]);

    const visibleThreadIds = useMemo(() => visibleNodes.map((node) => node.threadId), [visibleNodes]);

    // Select (never deselect) the visible threads active in the range. Pinned ones are skipped inside.
    const handleSelectByDate = useCallback(
        (range: ThreadDateRange) => {
            const matchingIds = selectThreadIdsByDate(visibleNodes, range);

            if (matchingIds.length === 0) {
                showInfo(t`No threads were active in that date range.`);

                return;
            }

            setSelectedThreadIds((previous) => new Set([...previous, ...matchingIds]));
        },
        [visibleNodes, setSelectedThreadIds, t],
    );

    const isAllSelected = useMemo(
        () => visibleThreadIds.length > 0 && visibleThreadIds.every((id) => selectedThreadIds.has(id)),
        [visibleThreadIds, selectedThreadIds],
    );

    const handleSelectAll = useCallback(() => {
        if (isAllSelected) {
            setSelectedThreadIds((previous) => {
                const next = new Set(previous);

                visibleThreadIds.forEach((id) => next.delete(id));

                return next;
            });
        } else {
            setSelectedThreadIds((previous) => {
                const next = new Set(previous);

                visibleThreadIds.forEach((id) => next.add(id));

                return next;
            });
        }
    }, [isAllSelected, visibleThreadIds, setSelectedThreadIds]);

    const handleClearSelection = useCallback(() => {
        setSelectedThreadIds(new Set());
        setLastSelectedIndex(-1);
    }, [setSelectedThreadIds, setLastSelectedIndex]);

    // Flatten threads for keyboard navigation
    const flattenedThreads = useMemo(() => {
        const flattened: BranchNode[] = [];

        const flattenNode = (node: BranchNode) => {
            flattened.push(node);

            if (expandedThreads.has(node.threadId)) {
                node.children.forEach((child) => flattenNode(child));
            }
        };

        threadGroups.forEach((group) => {
            if (!group.isCollapsed) {
                group.threads.forEach((thread) => flattenNode(thread));
            }
        });

        return flattened;
    }, [threadGroups, expandedThreads]);

    const navigate = useNavigate({ from: "/chat/$threadId" });
    const {
        handleArrowDown,
        handleArrowUp,
        handleEnter,
        handleEscape: handleKeyboardEscape,
        handleOpenSelectedMenu,
        handleRenameSelected,
        isKeyboardNavigating,
        resetNavigation,
        selectedThreadIndex,
    } = useKeyboardNavigation({
        flattenedThreads,
        navigate: useCallback(
            ({ threadId }: { threadId: string }) => {
                // Use startTransition to make thread switch non-blocking
                startTransition(() => {
                    navigate({
                        params: { threadId },
                        to: "/chat/$threadId",
                    });
                });
            },
            [navigate],
        ),
    });

    // Handle thread selection with shift-click support
    const handleThreadToggle = useCallback(
        (threadId: string, index: number, isShiftClick: boolean) => {
            if (isShiftClick && lastSelectedIndex >= 0 && lastSelectedIndex !== index) {
                // Range selection
                const start = Math.min(lastSelectedIndex, index);
                const end = Math.max(lastSelectedIndex, index);
                const rangeThreads = flattenedThreads.slice(start, end + 1);
                const rangeIds = rangeThreads.map((candidate) => candidate.threadId);

                setSelectedThreadIds((previous) => {
                    const next = new Set(previous);
                    const allSelected = rangeIds.every((id) => next.has(id));

                    if (allSelected) {
                        // Deselect all in range
                        rangeIds.forEach((id) => next.delete(id));
                    } else {
                        // Select all in range
                        rangeIds.forEach((id) => next.add(id));
                    }

                    return next;
                });
            } else {
                // Single selection
                setSelectedThreadIds((previous) => {
                    const next = new Set(previous);

                    if (next.has(threadId)) {
                        next.delete(threadId);
                    } else {
                        next.add(threadId);
                    }

                    return next;
                });
            }

            setLastSelectedIndex(index);
        },
        [flattenedThreads, lastSelectedIndex, setSelectedThreadIds, setLastSelectedIndex],
    );

    const handleBulkDelete = useCallback(async () => {
        const threadIdsToDelete = [...selectedThreadIds];

        if (threadIdsToDelete.length === 0) {
            return;
        }

        // If current thread is selected, navigate away first
        if (currentThreadId && selectedThreadIds.has(currentThreadId)) {
            // Find a thread that's not being deleted
            const safeThread = visibleThreadIds.find((id) => !selectedThreadIds.has(id));

            if (safeThread) {
                navigate({ from: "/chat/$threadId", params: { threadId: safeThread }, search: { initialMessage: undefined }, to: "/chat/$threadId" });
            } else {
                navigate({ from: "/chat/$threadId", search: {}, to: "/chat" });
            }
        }

        // Delete all selected threads using bulk delete
        await handleBulkDeleteThreads(threadIdsToDelete);

        // Exit selection mode
        handleClearSelection();
        onExitSelectionMode();
    }, [selectedThreadIds, currentThreadId, visibleThreadIds, handleBulkDeleteThreads, navigate, handleClearSelection, onExitSelectionMode]);

    // Helper to get all thread IDs in a group (including children if expanded)
    const getGroupThreadIds = useCallback(
        (group: ThreadGroup) => {
            const ids: string[] = [];

            const collectIds = (node: BranchNode) => {
                ids.push(node.threadId);

                if (expandedThreads.has(node.threadId)) {
                    node.children.forEach((child) => collectIds(child));
                }
            };

            if (!group.isCollapsed) {
                group.threads.forEach((thread) => collectIds(thread));
            }

            return ids;
        },
        [expandedThreads],
    );

    // Handle group checkbox toggle
    const handleGroupToggle = useCallback(
        (group: ThreadGroup, e: React.MouseEvent) => {
            e.stopPropagation();
            const groupThreadIds = getGroupThreadIds(group);
            const allSelected = isGroupFullySelected(groupThreadIds, selectedThreadIds);

            setSelectedThreadIds((previous) => {
                const next = new Set(previous);

                if (allSelected) {
                    groupThreadIds.forEach((id) => next.delete(id));
                } else {
                    groupThreadIds.forEach((id) => next.add(id));
                }

                return next;
            });
        },
        [getGroupThreadIds, selectedThreadIds, setSelectedThreadIds],
    );

    // Drag and drop sensors
    const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, KEYBOARD_SENSOR_OPTIONS));

    // Handle drag end - implement thread reordering and moving to projects
    const handleDragEnd = useCallback(
        async (event: any) => {
            const { active, over } = event;

            if (!over || active.id === over.id) {
                return;
            }

            // While the list is the stored copy, orders built from it are stale (chats made elsewhere would sink, deleted ones linger), and its stand-in project group spans projects.
            if (isDragBlocked(threadGroups, isPlaceholderData, active.id, over.id)) {
                return;
            }

            setLoadingStates((previous) => {
                return { ...previous, reordering: true };
            });

            try {
                await applyDragEnd(active, over, threadGroups, {
                    moveThreadToProject,
                    updateProjectOrder: updateProjectOrderMutation,
                    updateThreadOrder: updateThreadOrderMutation,
                });
            } catch {
                showError(t`Failed to move thread`);
            }

            setLoadingStates((previous) => {
                return { ...previous, reordering: false };
            });
        },
        [setLoadingStates, updateThreadOrderMutation, updateProjectOrderMutation, threadGroups, isPlaceholderData, moveThreadToProject, t],
    );

    // Keyboard shortcuts - extracted to dedicated hook
    useThreadListKeyboard({
        handleArrowDown,
        handleArrowUp,
        handleEnter,
        handleKeyboardEscape,
        handleOpenSelectedMenu,
        handleRenameSelected,
        handleSelectAll,
        isKeyboardNavigating,
        isSelectionMode,
        navigate,
        onExitSelectionMode,
        selectedThreadIndex,
        setShowKeyboardHelp,
    });

    // Reset keyboard navigation on mouse interaction. Every row gets this, so it does not change when navigation starts or stops:
    // resetting when nothing is selected sets the state it already has, which renders nothing.
    const handleMouseEnter = resetNavigation;
    // The arrow keys' row, by id: the flat index matches no row's own index (those restart in each group), and child rows need it too.
    const keyboardThreadId = isKeyboardNavigating ? flattenedThreads[selectedThreadIndex]?.threadId : undefined;

    // Flatten all visible items for virtualization (groups + threads)
    const virtualItems = useMemo(() => {
        const items: ({ group: ThreadGroup; groupType: GroupType; type: "group" } | { index: number; thread: BranchNode; type: "thread" })[] = [];

        threadGroups.forEach((group) => {
            const groupType = getGroupType(group);

            items.push({ group, groupType, type: "group" });

            if (!group.isCollapsed) {
                group.threads.forEach((thread, index) => {
                    items.push({ index, thread, type: "thread" });
                });
            }
        });

        return items;
    }, [threadGroups]);

    // Note: useVirtualizer is incompatible with React Compiler
    // The virtualized rendering is handled in renderThreadGroups below

    // The rename dialog and the open options menu live here, not in a row: a row can unmount while one is open
    // (virtualization, a filter). Each closes with its thread: when the thread leaves the list, or a rename's thread is locked.
    // The list root: rename returns focus here when the thread's row has unmounted.
    const listRootReference = useRef<HTMLDivElement>(null);
    const renameThreadId = useThreadListUIStore((state) => state.renameThreadId);
    const setRenameThreadId = useThreadListUIStore((state) => state.setRenameThreadId);
    const optionsMenuThreadId = useThreadListUIStore((state) => state.optionsMenuThreadId);
    const setOptionsMenuThreadId = useThreadListUIStore((state) => state.setOptionsMenuThreadId);
    const renameThread = renameThreadId === null ? undefined : flattenedThreads.find((node) => node.threadId === renameThreadId);
    const optionsMenuThread = optionsMenuThreadId === null ? undefined : flattenedThreads.find((node) => node.threadId === optionsMenuThreadId);
    const snoozeThreadId = useThreadListUIStore((state) => state.snoozeThreadId);
    const setSnoozeThreadId = useThreadListUIStore((state) => state.setSnoozeThreadId);
    const snoozeThread = snoozeThreadId === null ? undefined : flattenedThreads.find((node) => node.threadId === snoozeThreadId);

    // Like rename: the snooze dialog closes with its thread, so it cannot reopen when the thread comes back.
    useEffect(() => {
        if (snoozeThreadId !== null && snoozeThread === undefined) {
            setSnoozeThreadId(null);
        }
    }, [snoozeThread, snoozeThreadId, setSnoozeThreadId]);

    useEffect(() => {
        if (renameThreadId !== null && (renameThread === undefined || isThreadLocked(renameThread.lockedAt))) {
            setRenameThreadId(null);
        }
    }, [renameThread, renameThreadId, setRenameThreadId]);

    useEffect(() => {
        if (optionsMenuThreadId !== null && (optionsMenuThread === undefined || isThreadLocked(optionsMenuThread.lockedAt))) {
            setOptionsMenuThreadId(null);
        }
    }, [optionsMenuThread, optionsMenuThreadId, setOptionsMenuThreadId]);

    // The targets live in the store, which outlives the list: leaving the list clears them, so none reopens on return.
    useEffect(
        () => () => {
            setRenameThreadId(null);
            setOptionsMenuThreadId(null);
            setSnoozeThreadId(null);
        },
        [setRenameThreadId, setOptionsMenuThreadId, setSnoozeThreadId],
    );

    // Show loading state if threads are still loading
    if (!threadsData) {
        return (
            <div className="flex h-full items-center justify-center">
                <div className="text-muted-foreground flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span className="text-sm">{t`Loading threads...`}</span>
                </div>
            </div>
        );
    }

    // Show empty state if no threads (check threadGroups to include temporary threads)
    if (threadGroups.length === 0 && !searchQuery.trim()) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-muted-foreground">{t`No threads yet`}</p>
                <p className="text-muted-foreground text-xs">{t`Start a new conversation to create your first thread`}</p>
                <p className="mt-2 text-xs opacity-70">{t`Press ? for keyboard shortcuts`}</p>
            </div>
        );
    }

    // Show empty state for search results
    if (threadGroups.length === 0 && searchQuery.trim() && isSearchError) {
        return (
            <div className="text-muted-foreground px-3 py-8 text-center text-sm">
                <p role="alert">{t`Search failed for "${searchQuery}". Try again.`}</p>
                <p className="mt-2 text-xs opacity-70">{t`Press ? for keyboard shortcuts`}</p>
            </div>
        );
    }

    if (threadGroups.length === 0 && searchQuery.trim()) {
        const message = searchType === "threads" ? t`No threads found for` : t`No messages found for`;

        return (
            <div className="text-muted-foreground px-3 py-8 text-center text-sm">
                {isSearchLoading ? (
                    <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>{t`Searching...`}</span>
                    </div>
                ) : (
                    <>
                        <p>{`${message} "${searchQuery}"`}</p>
                        <p className="mt-1 text-xs">
                            {searchType === "threads" ? t`Try searching in thread titles or summaries` : t`Try searching in message content`}
                        </p>
                    </>
                )}
                <p className="mt-2 text-xs opacity-70">{t`Press ? for keyboard shortcuts`}</p>
            </div>
        );
    }

    // Render thread groups with virtualization
    const renderThreadGroups = () => {
        // Determine if we should use virtual scrolling based on total items
        // Lower threshold (15 instead of 30) for better performance with medium-sized lists
        const shouldUseVirtualScrolling = virtualItems.length > 15;

        if (!shouldUseVirtualScrolling) {
            // Non-virtualized rendering for small lists
            // Separate project groups from other groups for sorting
            const topGroups = threadGroups.filter((g) => g.groupType === "needsYou" || g.groupType === "working");
            const projectGroups = threadGroups.filter((g) => g.projectId);
            const otherGroups = threadGroups.filter((g) => !g.projectId && !topGroups.includes(g));
            const projectGroupIds = projectGroups.map((g) => `project-group-${g.projectId}`);

            const renderPlainGroup = (group: ThreadGroup) => {
                const project = group.projectId ? projectsMap.get(group.projectId) : null;
                const isProjectGroup = getGroupType(group) === "project" && Boolean(group.projectId);

                return (
                    <ProjectGroupContainer isProjectGroup={isProjectGroup} key={group.title} projectId={group.projectId}>
                        <ThreadGroupRenderer
                            expandedThreads={expandedThreads}
                            flattenedThreads={flattenedThreads}
                            getGroupThreadIds={getGroupThreadIds}
                            group={group}
                            handleCreateBranch={handleCreateBranch}
                            handleDeleteProject={handleDeleteProject}
                            handleDeleteThread={handleDeleteThread}
                            handleDownloadThread={handleDownloadThread}
                            handleEditProject={handleEditProject}
                            handleGroupToggle={handleGroupToggle}
                            handleMouseEnter={handleMouseEnter}
                            handlePinProject={handlePinProject}
                            handlePinThread={handlePinThread}
                            handleThreadToggle={handleThreadToggle}
                            handleUnpinThread={handleUnpinThread}
                            isSelectionMode={isSelectionMode}
                            loadingStates={loadingStates}
                            projectPinnedAt={project?.pinnedAt}
                            selectedThreadIds={selectedThreadIds}
                            toggleExpanded={toggleExpanded}
                            toggleGroupCollapsed={toggleGroupCollapsed}
                            updateThread={updateThread}
                        />
                    </ProjectGroupContainer>
                );
            };

            return (
                <>
                    {/* Derived sections sit above everything, Snoozed sits with the others; none of them is a drop target. */}
                    {topGroups.map((group) => renderPlainGroup(group))}
                    {projectGroups.length > 0 && (
                        <SortableContext items={projectGroupIds} strategy={verticalListSortingStrategy}>
                            {projectGroups.map((group) => {
                                const project = group.projectId ? projectsMap.get(group.projectId) : null;
                                const isProjectGroup = getGroupType(group) === "project" && Boolean(group.projectId);

                                return (
                                    <SortableProjectGroup key={group.projectId} projectId={group.projectId!}>
                                        {(dragListeners) => (
                                            <ProjectGroupContainer isProjectGroup={isProjectGroup} projectId={group.projectId}>
                                                <ThreadGroupRenderer
                                                    dragListeners={dragListeners}
                                                    expandedThreads={expandedThreads}
                                                    flattenedThreads={flattenedThreads}
                                                    getGroupThreadIds={getGroupThreadIds}
                                                    group={group}
                                                    handleCreateBranch={handleCreateBranch}
                                                    handleDeleteProject={handleDeleteProject}
                                                    handleDeleteThread={handleDeleteThread}
                                                    handleDownloadThread={handleDownloadThread}
                                                    handleEditProject={handleEditProject}
                                                    handleGroupToggle={handleGroupToggle}
                                                    handleMouseEnter={handleMouseEnter}
                                                    handlePinProject={handlePinProject}
                                                    handlePinThread={handlePinThread}
                                                    handleThreadToggle={handleThreadToggle}
                                                    handleUnpinThread={handleUnpinThread}
                                                    isReordering={loadingStates.reordering}
                                                    isSelectionMode={isSelectionMode}
                                                    loadingStates={loadingStates}
                                                    projectPinnedAt={project?.pinnedAt}
                                                    selectedThreadIds={selectedThreadIds}
                                                    toggleExpanded={toggleExpanded}
                                                    toggleGroupCollapsed={toggleGroupCollapsed}
                                                    updateThread={updateThread}
                                                />
                                            </ProjectGroupContainer>
                                        )}
                                    </SortableProjectGroup>
                                );
                            })}
                        </SortableContext>
                    )}

                    {otherGroups.map((group) => renderPlainGroup(group))}
                </>
            );
        }

        // Virtualized rendering for large lists
        // Extract to separate component to isolate useVirtualizer from React Compiler
        return (
            <VirtualizedThreadList
                expandedThreads={expandedThreads}
                flattenedThreads={flattenedThreads}
                getGroupThreadIds={getGroupThreadIds}
                handleCreateBranch={handleCreateBranch}
                handleDeleteProject={handleDeleteProject}
                handleDeleteThread={handleDeleteThread}
                handleDownloadThread={handleDownloadThread}
                handleEditProject={handleEditProject}
                handleGroupToggle={handleGroupToggle}
                handleMouseEnter={handleMouseEnter}
                handlePinProject={handlePinProject}
                handlePinThread={handlePinThread}
                handleThreadToggle={handleThreadToggle}
                handleUnpinThread={handleUnpinThread}
                isSelectionMode={isSelectionMode}
                loadingStates={loadingStates}
                projectsMap={projectsMap}
                selectedThreadIds={selectedThreadIds}
                toggleExpanded={toggleExpanded}
                toggleGroupCollapsed={toggleGroupCollapsed}
                updateThread={updateThread}
                virtualItems={virtualItems}
            />
        );
    };

    // Regular rendering with groups
    return (
        // The list root stays mounted while the list is, so it is the fallback focus target when a row unmounts during a rename.
        // Focused as the fallback when a rename's row has unmounted: its ring is the only focus cue there, so it stays visible.
        <PullRequestCountsProvider threadIds={visibleThreadIds}>
            <KeyboardSelectionProvider threadId={keyboardThreadId}>
                <SearchQueryContext value={searchQuery}>
                    <div
                        className="focus-visible:ring-ring/50 relative flex flex-col gap-2 rounded-md outline-none focus-visible:ring-2"
                        ref={listRootReference}
                        tabIndex={-1}
                    >
                        {isSelectionMode && (
                            <SelectionToolbar
                                isAllSelected={isAllSelected}
                                onClearSelection={handleClearSelection}
                                onDeleteSelected={handleBulkDelete}
                                onDone={onExitSelectionMode}
                                onSelectAll={handleSelectAll}
                                onSelectByDate={handleSelectByDate}
                                selectedCount={selectedThreadIds.size}
                            />
                        )}
                        <DndContext collisionDetection={closestCorners} onDragEnd={handleDragEnd} sensors={sensors}>
                            {renderThreadGroups()}
                        </DndContext>
                        {hasOpenedProjectForm && (
                            <Suspense fallback={null}>
                                <ProjectFormDialog
                                    editingProject={editingProject}
                                    onClose={() => setShowProjectFormDialog(false)}
                                    open={showProjectFormDialog}
                                />
                            </Suspense>
                        )}
                        <DeleteConfirmationDialog
                            description={t`This will permanently delete the project and all associated threads. This action cannot be undone.`}
                            isDeleting={isDeletingProject}
                            itemName={projectToDelete?.name}
                            onConfirm={handleConfirmDeleteProject}
                            onOpenChange={(open) => {
                                if (!open) {
                                    setProjectToDelete(null);
                                }
                            }}
                            open={!!projectToDelete}
                            title={t`Delete Project`}
                        />
                        {snoozeThread && (
                            <SnoozeUntilDialog
                                key={snoozeThread.threadId}
                                onOpenChange={(open) => {
                                    if (!open) {
                                        setSnoozeThreadId(null);
                                    }
                                }}
                                open
                                previousUntil={snoozeThread.snoozedUntil}
                                restoreFocus={() => renameFocusTarget(listRootReference.current, snoozeThread.threadId)}
                                threadId={snoozeThread.threadId}
                            />
                        )}
                        {renameThread && !isThreadLocked(renameThread.lockedAt) && (
                            <RenameThreadDialog
                                onOpenChange={(open) => {
                                    if (!open) {
                                        setRenameThreadId(null);
                                    }
                                }}
                                open
                                restoreFocus={() => renameFocusTarget(listRootReference.current, renameThread.threadId)}
                                storedTitle={renameThread.storedTitle ?? renameThread.title}
                                threadId={renameThread.threadId}
                            />
                        )}
                    </div>
                </SearchQueryContext>
            </KeyboardSelectionProvider>
        </PullRequestCountsProvider>
    );
};

export default memo(HierarchicalThreadList);
