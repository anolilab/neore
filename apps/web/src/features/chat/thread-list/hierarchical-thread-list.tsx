import { closestCorners, DndContext, KeyboardSensor, PointerSensor, useDroppable, useSensor, useSensors } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { KeyCombo, Keys, KeySymbol, ShortcutsProvider } from "@neore/ui/components/keyboard-shortcuts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Loader2, Trash2, X } from "lucide-react";
import type { FC, ReactNode } from "react";
import { lazy, memo, startTransition, Suspense, useCallback, useId, useMemo, useRef, useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
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
import { showError } from "@/lib/toast";

import ThreadGroupRenderer from "./components/thread-group-renderer";
import GroupHeader from "./group-header";
import useKeyboardNavigation from "./hooks/use-keyboard-navigation";
import useThreadGroups from "./hooks/use-thread-groups";
import useThreadHandlers from "./hooks/use-thread-handlers";
import useThreadListKeyboard from "./hooks/use-thread-list-keyboard";
import SortableThreadItem from "./sortable-thread-item";
import type { BranchNode, GroupType, HierarchicalThreadListProperties, MinimalThreadRelationship, ThreadGroup } from "./types";
import { getGroupType, isGroupFullySelected } from "./utilities";

// Lazy: it pulls `lucide-react/dynamic`'s import map of every icon (~190KB) for its icon picker.
const ProjectFormDialog = lazy(() => import("@/features/projects/components/project-form-dialog"));

// ============================================================================
// Inlined Components (previously separate files)
// ============================================================================

// KeyboardHelp - Shows keyboard shortcuts overlay
const keyboardHelpMappings = {
    "?": { label: "Question Mark", symbols: { default: "?" } },
    a: { label: "A", symbols: { default: "A" } },
    b: { label: "B", symbols: { default: "B" } },
    d: { label: "D", symbols: { default: "D" } },
    f: { label: "F", symbols: { default: "F" } },
    n: { label: "N", symbols: { default: "N" } },
    p: { label: "P", symbols: { default: "P" } },
};

const KeyboardHelp: FC<{ onClose: () => void; show: boolean }> = ({ onClose, show }) => {
    const { t } = useLingui();

    if (!show) {
        return null;
    }

    return (
        <div className="bg-background/95 inset-0 z-50 rounded-lg border p-4 backdrop-blur-sm">
            <ShortcutsProvider keyMappings={keyboardHelpMappings}>
                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold">{t`Keyboard Shortcuts`}</h3>
                        <Button aria-label={t`Close`} className="h-6 w-6 p-0" onClick={onClose} size="icon" variant="ghost">
                            ×
                        </Button>
                    </div>
                    <div className="grid grid-cols-1 gap-2 text-xs">
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`New thread`}</span>
                            <KeyCombo keyNames={[Keys.Command, "n"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`New temporary thread`}</span>
                            <KeyCombo keyNames={[Keys.Command, Keys.Shift, "n"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Delete thread`}</span>
                            <KeyCombo keyNames={[Keys.Command, "d"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Pin/Unpin thread`}</span>
                            <KeyCombo keyNames={[Keys.Command, "p"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Create branch`}</span>
                            <KeyCombo keyNames={[Keys.Command, "b"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Archive/Unarchive thread`}</span>
                            <KeyCombo keyNames={[Keys.Command, "a"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Search threads`}</span>
                            <KeyCombo keyNames={[Keys.Command, "f"]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Navigate threads`}</span>
                            <KeyCombo keyNames={[Keys.ArrowUp, Keys.ArrowDown]} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Open thread`}</span>
                            <KeySymbol keyName={Keys.Enter} />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Show/hide help`}</span>
                            <KeySymbol keyName="?" />
                        </div>
                        <div className="flex items-center justify-between">
                            <span className="text-muted-foreground">{t`Cancel/escape`}</span>
                            <KeySymbol keyName={Keys.Escape} />
                        </div>
                    </div>
                </div>
            </ShortcutsProvider>
        </div>
    );
};

// SelectionToolbar - Toolbar for bulk thread operations
const SelectionToolbar: FC<{
    isAllSelected: boolean;
    onClearSelection: () => void;
    onDeleteSelected: () => void;
    onDone: () => void;
    onSelectAll: () => void;
    selectedCount: number;
}> = memo(({ isAllSelected, onClearSelection, onDeleteSelected, onDone, onSelectAll, selectedCount }) => {
    const { t } = useLingui();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);

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

const VirtualizedThreadList: FC<{
    currentThreadId: string | undefined;
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
    isKeyboardNavigating: boolean;
    isSelectionMode: boolean;
    loadingStates: any;
    projectsMap: Map<string, any>;
    searchQuery: string;
    selectedThreadIds: Set<string>;
    selectedThreadIndex: number;
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
                                    currentThreadId={props.currentThreadId}
                                    expandedThreads={props.expandedThreads}
                                    handleCreateBranch={props.handleCreateBranch}
                                    handleDeleteThread={props.handleDeleteThread}
                                    handleDownloadThread={props.handleDownloadThread}
                                    handleMouseEnter={props.handleMouseEnter}
                                    handlePinThread={props.handlePinThread}
                                    handleThreadToggle={props.handleThreadToggle}
                                    handleUnpinThread={props.handleUnpinThread}
                                    index={item.index}
                                    isKeyboardNavigating={props.isKeyboardNavigating}
                                    isKeyboardSelected={props.isKeyboardNavigating && item.index === props.selectedThreadIndex}
                                    isSelected={props.selectedThreadIds.has(item.thread.threadId)}
                                    isSelectionMode={props.isSelectionMode}
                                    key={item.thread.threadId}
                                    loadingStates={props.loadingStates}
                                    node={item.thread}
                                    searchQuery={props.searchQuery}
                                    selectedThreadIds={props.selectedThreadIds}
                                    selectedThreadIndex={props.selectedThreadIndex}
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
    setShowSearch,
    showKeyboardHelp,
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

    const { handleBulkDeleteThreads, handleCreateBranch, handleDeleteThread, handleDownloadThread, handlePinThread, handleUnpinThread, updateThread } =
        useThreadHandlers(setLoadingStates, currentThreadId);

    const { threadGroups, threadsData } = useThreadGroups(
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

        try {
            // Ids in this component travel as plain strings (dnd-kit `active.id`/`over.id`,
            // `BranchNode`/`ThreadGroup` fields, local dialog state) but always originate
            // from documents returned by the backend, so the brand is re-applied here.
            await deleteProject({ projectId: projectToDelete.id as Id<"projects"> });
            setProjectToDelete(null);
        } catch (error) {
            console.error("Failed to delete project:", error);
            showError(t`Failed to delete project`);
        } finally {
            setIsDeletingProject(false);
        }
    }, [deleteProject, projectToDelete, t]);

    const handlePinProject = useCallback(
        async (projectId: string, isPinned: boolean) => {
            try {
                const brandedProjectId = projectId as Id<"projects">;

                await (isPinned ? unpinProject({ projectId: brandedProjectId }) : pinProject({ projectId: brandedProjectId }));
            } catch (error) {
                console.error("Failed to pin/unpin project:", error);
            }
        },
        [pinProject, unpinProject],
    );

    // Convert Set to sorted array for stable memoization
    const expandedThreadsArray = useMemo(() => [...expandedThreads].toSorted((a, b) => a.localeCompare(b)), [expandedThreads]);

    // Get all visible thread IDs for selection
    const visibleThreadIds = useMemo(() => {
        const visible: string[] = [];
        const expandedSet = new Set(expandedThreadsArray); // Reconstruct Set from array

        const collectThreadIds = (node: BranchNode) => {
            visible.push(node.threadId);

            if (expandedSet.has(node.threadId)) {
                node.children.forEach((child) => collectThreadIds(child));
            }
        };

        threadGroups.forEach((group) => {
            if (!group.isCollapsed) {
                group.threads.forEach((thread) => collectThreadIds(thread));
            }
        });

        return visible;
    }, [threadGroups, expandedThreadsArray]);

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
    const sensors = useSensors(
        useSensor(PointerSensor),
        useSensor(KeyboardSensor, {
            coordinateGetter: sortableKeyboardCoordinates,
        }),
    );

    // Handle drag end - implement thread reordering and moving to projects
    const handleDragEnd = useCallback(
        async (event: any) => {
            const { active, over } = event;

            if (!over || active.id === over.id) {
                return;
            }

            setLoadingStates((previous) => {
                return { ...previous, reordering: true };
            });

            try {
                // Check if we're reordering project groups
                const activeId = active.id as string;
                const isProjectGroupDrag = activeId.startsWith("project-group-");

                // If dragging a project group, only handle project group reordering
                // Don't fall through to thread handling
                if (isProjectGroupDrag) {
                    const activeProjectId = activeId.replace("project-group-", "");
                    const overId = over.id as string;

                    // Check if dropping on another project group (could be project-group-{id} or project-{id})
                    let overProjectId: string | undefined;

                    if (overId.startsWith("project-group-")) {
                        overProjectId = overId.replace("project-group-", "");
                    } else if (overId.startsWith("project-") && !overId.startsWith("project-group-")) {
                        // Dropping on ProjectGroupContainer (but not a project-group- ID)
                        overProjectId = overId.replace("project-", "");
                    } else if (over.data?.current?.type === "project-container" && over.data.current.projectId) {
                        // Dropping on project container via data
                        overProjectId = over.data.current.projectId;
                    }

                    // Only reorder if we found a valid target project and it's different from the source
                    if (overProjectId && overProjectId !== activeProjectId) {
                        // Find project groups in threadGroups (maintain current order from threadGroups)
                        const projectGroups = threadGroups.filter((g) => g.projectId);
                        const activeIndex = projectGroups.findIndex((g) => g.projectId === activeProjectId);
                        const overIndex = projectGroups.findIndex((g) => g.projectId === overProjectId);

                        if (activeIndex !== -1 && overIndex !== -1 && activeIndex !== overIndex) {
                            const reorderedProjects = arrayMove(projectGroups, activeIndex, overIndex);

                            // Update project orders
                            const projectOrders = reorderedProjects.map((group, index) => {
                                return {
                                    order: index,
                                    projectId: group.projectId!,
                                };
                            });

                            await updateProjectOrderMutation({
                                projectOrders,
                            });
                        } else {
                            // If indices not found or same, still clear loading state
                            setLoadingStates((previous) => {
                                return { ...previous, reordering: false };
                            });

                            return;
                        }
                    } else {
                        // No valid drop target or same project - just clear loading
                        setLoadingStates((previous) => {
                            return { ...previous, reordering: false };
                        });

                        return;
                    }

                    // Always return early for project group drags - don't handle as thread
                    setLoadingStates((previous) => {
                        return { ...previous, reordering: false };
                    });

                    return;
                }

                // Only handle thread drags from here on
                const threadId = active.id as Id<"threads">;

                // Ensure we're not accidentally treating a project group ID as a thread ID
                if (threadId.startsWith("project-group-")) {
                    setLoadingStates((previous) => {
                        return { ...previous, reordering: false };
                    });

                    return;
                }

                // First, check if we're dropping on a project container (highest priority)
                // Check both the ID and the data type to ensure we catch project container drops
                const isProjectContainerDrop =
                    (typeof over.id === "string" && over.id.startsWith("project-")) || over.data?.current?.type === "project-container";

                if (isProjectContainerDrop) {
                    let targetProjectId: string | undefined;

                    if (typeof over.id === "string" && over.id.startsWith("project-")) {
                        targetProjectId = over.id.replace("project-", "");
                    } else if (over.data?.current?.projectId) {
                        targetProjectId = over.data.current.projectId;
                    }

                    // Find which project the thread currently belongs to
                    let currentProjectId: string | undefined;

                    for (const group of threadGroups) {
                        if (group.threads.some((candidate) => candidate.threadId === threadId)) {
                            currentProjectId = group.projectId;
                            break;
                        }
                    }

                    // Only move if it's a different project
                    if (currentProjectId !== targetProjectId) {
                        await moveThreadToProject({
                            projectId: (targetProjectId || undefined) as Id<"projects"> | undefined,
                            threadId,
                        });
                    }

                    setLoadingStates((previous) => {
                        return { ...previous, reordering: false };
                    });

                    return;
                }

                // Find which group the active and over items belong to
                let activeGroup: ThreadGroup | null = null;
                let overGroup: ThreadGroup | null = null;
                let activeIndex = -1;
                let overIndex = -1;

                for (const group of threadGroups) {
                    const activeThreadIndex = group.threads.findIndex((candidate) => candidate.threadId === active.id);
                    const overThreadIndex = group.threads.findIndex((candidate) => candidate.threadId === over.id);

                    if (activeThreadIndex !== -1) {
                        activeGroup = group;
                        activeIndex = activeThreadIndex;
                    }

                    if (overThreadIndex !== -1) {
                        overGroup = group;
                        overIndex = overThreadIndex;
                    }
                }

                // If we couldn't find the groups, check if over.id is a thread ID that belongs to a project
                // This handles the case where we drop on a thread inside a project container
                if (!overGroup && typeof over.id === "string") {
                    for (const group of threadGroups) {
                        if (group.threads.some((candidate) => candidate.threadId === over.id)) {
                            overGroup = group;
                            overIndex = group.threads.findIndex((candidate) => candidate.threadId === over.id);
                            break;
                        }
                    }
                }

                // Check if we're moving between different groups (including project groups)
                if (activeGroup && overGroup && activeGroup !== overGroup) {
                    // If moving from one project to another, use project move
                    if (activeGroup.projectId && overGroup.projectId && activeGroup.projectId !== overGroup.projectId) {
                        await moveThreadToProject({
                            projectId: overGroup.projectId as Id<"projects">,
                            threadId,
                        });
                        setLoadingStates((previous) => {
                            return { ...previous, reordering: false };
                        });

                        return;
                    }

                    // If moving from project to non-project group, remove from project
                    if (activeGroup.projectId && !overGroup.projectId) {
                        await moveThreadToProject({
                            projectId: undefined,
                            threadId,
                        });
                        setLoadingStates((previous) => {
                            return { ...previous, reordering: false };
                        });

                        return;
                    }

                    // If moving from non-project to project group, add to project
                    if (!activeGroup.projectId && overGroup.projectId) {
                        await moveThreadToProject({
                            projectId: overGroup.projectId as Id<"projects">,
                            threadId,
                        });
                        setLoadingStates((previous) => {
                            return { ...previous, reordering: false };
                        });

                        return;
                    }

                    // If moving between any different groups (not same group), don't reorder
                    setLoadingStates((previous) => {
                        return { ...previous, reordering: false };
                    });

                    return;
                }

                // Only allow reordering within the same group
                if (!activeGroup || !overGroup || activeGroup.title !== overGroup.title) {
                    setLoadingStates((previous) => {
                        return { ...previous, reordering: false };
                    });

                    return;
                }

                // Reorder threads within the group
                const reorderedThreads = arrayMove(activeGroup.threads, activeIndex, overIndex);

                // Update the order in the database
                const threadOrders = reorderedThreads.map((thread, index) => {
                    return {
                        order: index,
                        threadId: thread.threadId,
                    };
                });

                await updateThreadOrderMutation({
                    threadOrders,
                });
                setLoadingStates((previous) => {
                    return { ...previous, reordering: false };
                });
            } catch {
                showError(t`Failed to move thread`);
                setLoadingStates((previous) => {
                    return { ...previous, reordering: false };
                });
            }
        },
        [setLoadingStates, updateThreadOrderMutation, updateProjectOrderMutation, threadGroups, moveThreadToProject, t],
    );

    // Keyboard shortcuts - extracted to dedicated hook
    useThreadListKeyboard({
        currentThreadId,
        flattenedThreads,
        handleArrowDown,
        handleArrowUp,
        handleCreateBranch,
        handleDeleteThread,
        handleEnter,
        handleKeyboardEscape,
        handlePinThread,
        handleSelectAll,
        handleUnpinThread,
        isKeyboardNavigating,
        isSelectionMode,
        navigate,
        onExitSelectionMode,
        selectedThreadIndex,
        setShowKeyboardHelp,
        setShowSearch,
        updateThread,
    });

    // Reset keyboard navigation on mouse interaction
    const handleMouseEnter = useCallback(() => {
        if (isKeyboardNavigating) {
            resetNavigation();
        }
    }, [isKeyboardNavigating, resetNavigation]);

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
            const projectGroups = threadGroups.filter((g) => g.projectId);
            const otherGroups = threadGroups.filter((g) => !g.projectId);
            const projectGroupIds = projectGroups.map((g) => `project-group-${g.projectId}`);

            return (
                <>
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
                                                    currentThreadId={currentThreadId}
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
                                                    isKeyboardNavigating={isKeyboardNavigating}
                                                    isReordering={loadingStates.reordering}
                                                    isSelectionMode={isSelectionMode}
                                                    loadingStates={loadingStates}
                                                    projectPinnedAt={project?.pinnedAt}
                                                    searchQuery={searchQuery}
                                                    selectedThreadIds={selectedThreadIds}
                                                    selectedThreadIndex={selectedThreadIndex}
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

                    {/* Other groups (non-project) - uses extracted ThreadGroupRenderer */}
                    {otherGroups.map((group) => {
                        const project = group.projectId ? projectsMap.get(group.projectId) : null;
                        const isProjectGroup = getGroupType(group) === "project" && Boolean(group.projectId);

                        return (
                            <ProjectGroupContainer isProjectGroup={isProjectGroup} key={group.title} projectId={group.projectId}>
                                <ThreadGroupRenderer
                                    currentThreadId={currentThreadId}
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
                                    isKeyboardNavigating={isKeyboardNavigating}
                                    isSelectionMode={isSelectionMode}
                                    loadingStates={loadingStates}
                                    projectPinnedAt={project?.pinnedAt}
                                    searchQuery={searchQuery}
                                    selectedThreadIds={selectedThreadIds}
                                    selectedThreadIndex={selectedThreadIndex}
                                    toggleExpanded={toggleExpanded}
                                    toggleGroupCollapsed={toggleGroupCollapsed}
                                    updateThread={updateThread}
                                />
                            </ProjectGroupContainer>
                        );
                    })}
                </>
            );
        }

        // Virtualized rendering for large lists
        // Extract to separate component to isolate useVirtualizer from React Compiler
        return (
            <VirtualizedThreadList
                currentThreadId={currentThreadId}
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
                isKeyboardNavigating={isKeyboardNavigating}
                isSelectionMode={isSelectionMode}
                loadingStates={loadingStates}
                projectsMap={projectsMap}
                searchQuery={searchQuery}
                selectedThreadIds={selectedThreadIds}
                selectedThreadIndex={selectedThreadIndex}
                toggleExpanded={toggleExpanded}
                toggleGroupCollapsed={toggleGroupCollapsed}
                updateThread={updateThread}
                virtualItems={virtualItems}
            />
        );
    };

    // Regular rendering with groups
    return (
        <div className="relative flex flex-col gap-2">
            {isSelectionMode && (
                <SelectionToolbar
                    isAllSelected={isAllSelected}
                    onClearSelection={handleClearSelection}
                    onDeleteSelected={handleBulkDelete}
                    onDone={onExitSelectionMode}
                    onSelectAll={handleSelectAll}
                    selectedCount={selectedThreadIds.size}
                />
            )}
            <KeyboardHelp onClose={() => setShowKeyboardHelp(false)} show={showKeyboardHelp} />
            <DndContext collisionDetection={closestCorners} onDragEnd={handleDragEnd} sensors={sensors}>
                {renderThreadGroups()}
            </DndContext>
            {hasOpenedProjectForm && (
                <Suspense fallback={null}>
                    <ProjectFormDialog editingProject={editingProject} onClose={() => setShowProjectFormDialog(false)} open={showProjectFormDialog} />
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
        </div>
    );
};

export default memo(HierarchicalThreadList);
