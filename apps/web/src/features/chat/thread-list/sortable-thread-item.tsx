import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { FC } from "react";
import { memo } from "react";

import ThreadNode from "./thread-node";
import type { BranchNode } from "./types";

interface SortableThreadItemProperties {
    currentThreadId: string | undefined;
    expandedThreads: Set<string>;
    handleCreateBranch: (threadId: string) => void;
    handleDeleteThread: (threadId: string) => void;
    handleDownloadThread: (node: BranchNode, format: "json" | "txt" | "pdf") => void;
    handleMouseEnter: () => void;
    handlePinThread: (threadId: string) => void;
    handleThreadToggle: (threadId: string, index: number, isShiftClick: boolean) => void;
    handleUnpinThread: (threadId: string) => void;
    index?: number;
    isKeyboardNavigating: boolean;
    isKeyboardSelected: boolean;
    isSelected: boolean;
    isSelectionMode: boolean;
    loadingStates: import("./types").LoadingStates;
    node: BranchNode;
    searchQuery: string;
    selectedThreadIds: Set<string>;
    selectedThreadIndex: number;
    toggleExpanded: (threadId: string) => void;
    updateThread: (threadId: string, model: string, status: "archived" | "active") => void;
}

const SortableThreadItem: FC<SortableThreadItemProperties> = ({
    currentThreadId,
    expandedThreads,
    handleCreateBranch,
    handleDeleteThread,
    handleDownloadThread,
    handleMouseEnter,
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
    const { attributes, isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id: node.threadId });

    const style = {
        opacity: isDragging ? 0.5 : 1,
        transform: CSS.Transform.toString(transform),
        transition,
    };

    return (
        <div ref={setNodeRef} style={style} {...attributes} onMouseEnter={handleMouseEnter}>
            <ThreadNode
                currentThreadId={currentThreadId}
                dragListeners={listeners}
                expandedThreads={expandedThreads}
                handleCreateBranch={handleCreateBranch}
                handleDeleteThread={handleDeleteThread}
                handleDownloadThread={handleDownloadThread}
                handlePinThread={handlePinThread}
                handleThreadToggle={handleThreadToggle}
                handleUnpinThread={handleUnpinThread}
                index={index}
                isKeyboardSelected={isKeyboardSelected}
                isSelected={isSelected}
                isSelectionMode={isSelectionMode}
                loadingStates={loadingStates}
                node={node}
                searchQuery={searchQuery}
                selectedThreadIds={selectedThreadIds}
                toggleExpanded={toggleExpanded}
                updateThread={updateThread}
            />
        </div>
    );
};

export default memo(SortableThreadItem);
