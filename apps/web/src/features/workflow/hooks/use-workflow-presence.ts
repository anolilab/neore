import type { Id } from "@neore/backend/dataModel";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

const HEARTBEAT_INTERVAL = 5000; // 5 seconds
const CURSOR_DEBOUNCE = 100; // Debounce cursor updates to 100ms

/**
 * Presence state for a single user in a workflow room.
 */
export interface PresenceUser {
    cursorPosition: { x: number; y: number } | null;
    editingNodeId?: string;
    lastHeartbeat: number;
    selectedNodeId?: string;
    sessionId: string;
    userColor: string;
    userId: string;
    userName: string;
}

/**
 * Hook for managing real-time presence in a workflow editing session.
 *
 * Handles:
 * - Periodic heartbeat to maintain presence
 * - Cursor position tracking (debounced)
 * - Node selection/editing state
 * - Cleanup on unmount
 *
 * Uses Lunora reactive queries for real-time updates.
 */
const useWorkflowPresence = (projectId: string | null) => {
    const crpc = useCRPC();
    // Lazy state rather than `useRef(nanoid(12))`: the id is read while
    // rendering, and the ref form re-ran `nanoid` on every render only to throw
    // the result away.
    const [sessionId] = useState(() => nanoid(12));
    const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
    const cursorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Refs, not state: the selection/edit markers are only ever read back by the
    // heartbeat, never rendered, so mirroring them into state bought a re-render
    // and a render-phase ref write for nothing.
    const editingNodeIdRef = useRef<string | null>(null);
    const selectedNodeIdRef = useRef<string | null>(null);

    // Subscribe to presence list (reactive - updates in real-time)
    // `projectId` arrives as a plain string from the `/workflow/$workflowId` route
    // param, so the brand is re-applied at the query/mutation boundary.
    const { data: presenceList = [] } = useQuery(
        crpc.workflow.presence.listPresence.queryOptions(projectId ? { projectId: projectId as Id<"projects"> } : skipToken),
    );

    // Mutations - use refs to avoid unstable references resetting intervals
    const heartbeatMutation = useMutation(crpc.workflow.presence.heartbeat.mutationOptions());
    const heartbeatMutateRef = useRef(heartbeatMutation.mutate);

    const disconnectMutation = useMutation(crpc.workflow.presence.disconnect.mutationOptions());
    const disconnectMutateRef = useRef(disconnectMutation.mutate);

    // Refreshed after commit rather than during render — render must stay pure,
    // and both refs already hold the first render's function.
    useEffect(() => {
        heartbeatMutateRef.current = heartbeatMutation.mutate;
        disconnectMutateRef.current = disconnectMutation.mutate;
    });

    // Send heartbeat - use refs to avoid dependency changes resetting interval
    const sendHeartbeat = useCallback(
        (extras?: { cursorPosition?: { x: number; y: number } | null; editingNodeId?: string | null; selectedNodeId?: string | null }) => {
            if (!projectId) {
                return;
            }

            heartbeatMutateRef.current({
                cursorPosition: extras?.cursorPosition ?? lastCursorRef.current,
                editingNodeId: extras?.editingNodeId ?? editingNodeIdRef.current,
                projectId: projectId as Id<"projects">,
                selectedNodeId: extras?.selectedNodeId ?? selectedNodeIdRef.current,
                sessionId,
            });
        },
        [projectId, sessionId],
    );

    // Set up periodic heartbeat - stable dependencies prevent interval reset
    useEffect(() => {
        if (!projectId) {
            return undefined;
        }

        // Send initial heartbeat
        sendHeartbeat();

        const interval = setInterval(() => {
            sendHeartbeat();
        }, HEARTBEAT_INTERVAL);

        return () => {
            clearInterval(interval);
        };
    }, [projectId, sendHeartbeat]);

    // Clean up on unmount - clear cursor timer and disconnect
    useEffect(
        () => () => {
            // Clear any pending cursor debounce
            if (cursorTimerRef.current) {
                clearTimeout(cursorTimerRef.current);
            }

            // Disconnect from presence using ref for stable reference
            disconnectMutateRef.current({ sessionId });
        },
        // `sessionId` never changes, so this is still an unmount-only cleanup
        [sessionId],
    );

    // Update cursor position (debounced)
    const updateCursor = useCallback(
        (position: { x: number; y: number } | null) => {
            lastCursorRef.current = position;

            if (cursorTimerRef.current) {
                clearTimeout(cursorTimerRef.current);
            }

            cursorTimerRef.current = setTimeout(() => {
                sendHeartbeat({ cursorPosition: position });
            }, CURSOR_DEBOUNCE);
        },
        [sendHeartbeat],
    );

    // Update selected node
    const updateSelectedNode = useCallback(
        (nodeId: string | null) => {
            selectedNodeIdRef.current = nodeId;
            sendHeartbeat({ selectedNodeId: nodeId });
        },
        [sendHeartbeat],
    );

    // Start editing a node (acquires lock)
    const startEditingNode = useCallback(
        (nodeId: string | null) => {
            editingNodeIdRef.current = nodeId;
            sendHeartbeat({ editingNodeId: nodeId });
        },
        [sendHeartbeat],
    );

    // Stop editing a node (releases lock)
    const stopEditingNode = useCallback(() => {
        editingNodeIdRef.current = null;
        sendHeartbeat({ editingNodeId: null });
    }, [sendHeartbeat]);

    // Filter out current session from presence list (memoized for stable reference)
    const otherUsers = useMemo(() => presenceList.filter((p: PresenceUser) => p.sessionId !== sessionId), [presenceList, sessionId]);

    // Check if a node is locked by someone else
    const isNodeLockedByOther = useCallback(
        (nodeId: string): PresenceUser | null => otherUsers.find((u: PresenceUser) => u.editingNodeId === nodeId) ?? null,
        [otherUsers],
    );

    return {
        /** All users in the room (including self) */
        allUsers: presenceList as PresenceUser[],
        /** Whether presence is connected */
        isConnected: presenceList.length > 0,
        /** Check if a node is locked by another user */
        isNodeLockedByOther,
        /** Other users in the room (excluding self) */
        otherUsers: otherUsers as PresenceUser[],
        /** Current session ID */
        sessionId,
        /** Start editing a node (acquires soft lock) */
        startEditingNode,
        /** Stop editing current node (releases lock) */
        stopEditingNode,
        /** Update cursor position (debounced) */
        updateCursor,
        /** Update currently selected node */
        updateSelectedNode,
    };
};

export default useWorkflowPresence;
