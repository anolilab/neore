import type { ReactNode } from "react";
import { createContext, use, useCallback, useMemo } from "react";

import type { PresenceUser } from "../hooks/use-workflow-presence";

interface WorkflowCollabContextValue {
    /** Check if a node is being edited by another user */
    getNodeEditor: (nodeId: string) => PresenceUser | null;
    /** Check if a node is selected by another user (but not being edited) */
    getNodeSelector: (nodeId: string) => PresenceUser | null;
    /** Other users currently in the workflow (excluding self) */
    otherUsers: PresenceUser[];
    /** Start editing a node (acquires soft lock) */
    startEditingNode: (nodeId: string) => void;
    /** Stop editing current node (releases lock) */
    stopEditingNode: () => void;
}

const WorkflowCollabContext = createContext<WorkflowCollabContextValue | null>(null);

interface WorkflowCollabProviderProps {
    children: ReactNode;
    otherUsers: PresenceUser[];
    startEditingNode: (nodeId: string) => void;
    stopEditingNode: () => void;
}

export const WorkflowCollabProvider = ({ children, otherUsers, startEditingNode, stopEditingNode }: WorkflowCollabProviderProps) => {
    const getNodeEditor = useCallback((nodeId: string): PresenceUser | null => otherUsers.find((u) => u.editingNodeId === nodeId) ?? null, [otherUsers]);

    const getNodeSelector = useCallback(
        (nodeId: string): PresenceUser | null =>
            // Only return if selected but not editing
            otherUsers.find((u) => u.selectedNodeId === nodeId && u.editingNodeId !== nodeId) ?? null,
        [otherUsers],
    );

    const value = useMemo(() => {
        return {
            getNodeEditor,
            getNodeSelector,
            otherUsers,
            startEditingNode,
            stopEditingNode,
        };
    }, [otherUsers, getNodeEditor, getNodeSelector, startEditingNode, stopEditingNode]);

    return <WorkflowCollabContext value={value}>{children}</WorkflowCollabContext>;
};

/**
 * Hook to access collaboration context within workflow nodes.
 * Returns null if not within a WorkflowCollabProvider (solo editing mode).
 */
export const useWorkflowCollab = (): WorkflowCollabContextValue | null => use(WorkflowCollabContext);
