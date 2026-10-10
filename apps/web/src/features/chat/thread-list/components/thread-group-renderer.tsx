import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";
import { memo } from "react";

import GroupHeader from "../group-header";
import SortableThreadItem from "../sortable-thread-item";
import type { BranchNode, LoadingStates, ThreadGroup } from "../types";
import { getGroupType } from "../utilities";

interface ThreadGroupRendererProps {
    currentThreadId: string | undefined;
    /** dnd-kit listeners for the project drag handle. Absent for non-project groups. */
    dragListeners?: unknown;
    expandedThreads: Set<string>;
    flattenedThreads: BranchNode[];
    getGroupThreadIds: (group: ThreadGroup) => string[];
    group: ThreadGroup;
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
    isReordering?: boolean;
    isSelectionMode: boolean;
    loadingStates: LoadingStates;
    projectPinnedAt?: number | null;
    searchQuery: string;
    selectedThreadIds: Set<string>;
    selectedThreadIndex: number;
    toggleExpanded: (threadId: string) => void;
    toggleGroupCollapsed: (groupType: import("../types").GroupType, projectId?: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}

/**
 * Renders a single thread group with its header and thread items.
 *
 * Used for both plain groups (Today, Last 7 days, Pinned, …) and project groups;
 * the latter pass `dragListeners`/`isReordering` from the `SortableProjectGroup`
 * wrapper they are rendered inside.
 */
const ThreadGroupRenderer: FC<ThreadGroupRendererProps> = memo(
    ({
        currentThreadId,
        dragListeners,
        expandedThreads,
        flattenedThreads,
        getGroupThreadIds,
        group,
        handleCreateBranch,
        handleDeleteProject,
        handleDeleteThread,
        handleDownloadThread,
        handleEditProject,
        handleGroupToggle,
        handleMouseEnter,
        handlePinProject,
        handlePinThread,
        handleThreadToggle,
        handleUnpinThread,
        isKeyboardNavigating,
        isReordering,
        isSelectionMode,
        loadingStates,
        projectPinnedAt,
        searchQuery,
        selectedThreadIds,
        selectedThreadIndex,
        toggleExpanded,
        toggleGroupCollapsed,
        updateThread,
    }) => {
        const { t } = useLingui();

        return (
            <>
                <GroupHeader
                    dragListeners={dragListeners}
                    group={group}
                    groupThreadIds={getGroupThreadIds(group)}
                    isCollapsed={group.isCollapsed ?? false}
                    isReordering={isReordering}
                    isSelectionMode={isSelectionMode}
                    onDeleteProject={handleDeleteProject}
                    onEditProject={handleEditProject}
                    onPinProject={handlePinProject}
                    onToggleCollapse={() => {
                        if (isSelectionMode) {
                            return;
                        }

                        const groupType = getGroupType(group);

                        toggleGroupCollapsed(groupType, "projectId" in group ? group.projectId : undefined);
                    }}
                    onToggleSelection={(e) => handleGroupToggle(group, e)}
                    projectPinnedAt={projectPinnedAt}
                    selectedThreadIds={selectedThreadIds}
                />

                {/* Group Threads */}
                {!group.isCollapsed && (
                    <div className="space-y-1">
                        {group.threads.length === 0 ? (
                            <div className="text-muted-foreground px-2 py-4 text-center text-xs">
                                {group.projectId ? t`Drop threads here to add them to this project` : t`No threads in this group`}
                            </div>
                        ) : (
                            <SortableContext items={group.threads.map((candidate) => candidate.threadId)} strategy={verticalListSortingStrategy}>
                                {group.threads.map((thread) => {
                                    const threadIndexInFlattened = flattenedThreads.findIndex((candidate) => candidate.threadId === thread.threadId);
                                    const isKeyboardSelected = isKeyboardNavigating && threadIndexInFlattened === selectedThreadIndex;

                                    return (
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
                                            index={threadIndexInFlattened}
                                            isKeyboardNavigating={isKeyboardNavigating}
                                            isKeyboardSelected={isKeyboardSelected}
                                            isSelected={selectedThreadIds.has(thread.threadId)}
                                            isSelectionMode={isSelectionMode}
                                            key={thread.threadId}
                                            loadingStates={loadingStates}
                                            node={thread}
                                            searchQuery={searchQuery}
                                            selectedThreadIds={selectedThreadIds}
                                            selectedThreadIndex={selectedThreadIndex}
                                            toggleExpanded={toggleExpanded}
                                            updateThread={updateThread}
                                        />
                                    );
                                })}
                            </SortableContext>
                        )}
                    </div>
                )}
            </>
        );
    },
);

export default ThreadGroupRenderer;
