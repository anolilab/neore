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
    // Passed down by the list for its keyboard navigation; the sortable row does not read them.
    // eslint-disable-next-line react/no-unused-prop-types
    isKeyboardNavigating: boolean;
    isKeyboardSelected: boolean;
    isSelected: boolean;
    isSelectionMode: boolean;
    /** The keyboard-selected thread, so a child row can tell it is the one selected (the flat index means nothing inside a group). */
    keyboardThreadId?: string;
    loadingStates: import("./types").LoadingStates;
    node: BranchNode;
    searchQuery: string;
    selectedThreadIds: Set<string>;
    // eslint-disable-next-line react/no-unused-prop-types
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
    keyboardThreadId,
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
        <div onMouseEnter={handleMouseEnter} ref={setNodeRef} style={style}>
            <ThreadNode
                currentThreadId={currentThreadId}
                // The drag handle is the only focusable part of the sortable item: the row holds buttons and a link.
                dragAttributes={attributes}
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
                keyboardThreadId={keyboardThreadId}
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
