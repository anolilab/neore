import "@xyflow/react/dist/style.css";

import { useLingui } from "@lingui/react/macro";
import { Background, MiniMap, ReactFlow, ReactFlowProvider, useReactFlow } from "@xyflow/react";
import { nanoid } from "nanoid";
import { useRef, useState } from "react";

import { WorkflowCollabProvider } from "../../contexts";
import type { PresenceUser } from "../../hooks/use-workflow-presence";
import { useWorkflowShortcuts } from "../../hooks/use-workflow-shortcuts";
import { useWorkflowStore } from "../../stores/workflow-store";
import type { WorkflowEdge, WorkflowNode, WorkflowNodeType } from "../../types";
import NODE_CONFIGS from "../../types";
import CollaboratorCursors from "../collab/collaborator-cursors";
import { edgeTypes } from "../edges";
import { nodeTypes } from "../nodes";
import ConnectionDropMenu from "./connection-drop-menu";
import ExecutionHistoryPanel from "./execution-history-panel";
import KeyboardShortcutsDialog from "./keyboard-shortcuts-dialog";
import NodeSearchDialog from "./node-search-dialog";
import WorkflowBottomToolbar from "./workflow-bottom-toolbar";
import WorkflowControls from "./workflow-controls";
import WorkflowToolbar from "./workflow-toolbar";

interface WorkflowCanvasProps {
    className?: string;
    /** Remote collaborator cursors to render on the canvas */
    collaborators?: PresenceUser[];
    /** Callback when cursor moves on the canvas */
    onCursorMove?: (position: { x: number; y: number } | null) => void;
    /** Callback when node selection changes */
    onNodeSelect?: (nodeId: string | null) => void;
    onRun?: () => void;
    onSave?: () => void;
    /** Callback when user starts editing a node */
    onStartEditingNode?: (nodeId: string) => void;
    /** Callback when user stops editing a node */
    onStopEditingNode?: () => void;
}

// Noop functions for when collab is not active — module scope keeps their identity stable.
const noopStartEditing = (_nodeId: string) => {};
const noopStopEditing = () => {};

const WorkflowCanvasInner = ({
    className,
    collaborators,
    onCursorMove,
    onNodeSelect,
    onRun,
    onSave,
    onStartEditingNode,
    onStopEditingNode,
}: WorkflowCanvasProps) => {
    const reactFlowWrapper = useRef<HTMLDivElement>(null);
    const { getIntersectingNodes, screenToFlowPosition } = useReactFlow();
    const { i18n } = useLingui();

    const nodes = useWorkflowStore((state) => state.nodes);
    const edges = useWorkflowStore((state) => state.edges);
    const onNodesChange = useWorkflowStore((state) => state.onNodesChange);
    const onEdgesChange = useWorkflowStore((state) => state.onEdgesChange);
    const onConnect = useWorkflowStore((state) => state.onConnect);
    const setViewport = useWorkflowStore((state) => state.setViewport);
    const addNode = useWorkflowStore((state) => state.addNode);
    const selectNode = useWorkflowStore((state) => state.selectNode);
    const canvasMode = useWorkflowStore((state) => state.canvasMode);
    const setDraggingOverGroupId = useWorkflowStore((state) => state.setDraggingOverGroupId);
    const setEdges = useWorkflowStore((state) => state.setEdges);

    // Execution history panel state
    const [showHistory, setShowHistory] = useState(false);

    // Keyboard shortcuts help dialog
    const [showShortcuts, setShowShortcuts] = useState(false);

    // Node search / command palette
    const [showNodeSearch, setShowNodeSearch] = useState(false);

    // Connection drop menu state
    const [connectionDropMenu, setConnectionDropMenu] = useState<{
        handleType: "source" | "target";
        position: { x: number; y: number };
        sourceHandleId: string | null;
        sourceNodeId: string;
    } | null>(null);
    const connectingRef = useRef<{
        handleId: string | null;
        handleType: "source" | "target" | null;
        nodeId: string | null;
    }>({ handleId: null, handleType: null, nodeId: null });

    useWorkflowShortcuts({
        onRun,
        onSave,
        onShowNodeSearch: () => setShowNodeSearch(true),
        onShowShortcuts: () => setShowShortcuts(true),
    });

    // Track connection start for the drop menu
    const onConnectStart = (
        _event: MouseEvent | TouchEvent,
        params: { handleId: string | null; handleType: "source" | "target" | null; nodeId: string | null },
    ) => {
        connectingRef.current = params;
    };

    // Show drop menu when connection is dropped on empty canvas
    const onConnectEnd = (event: MouseEvent | TouchEvent) => {
        const { handleId, handleType, nodeId } = connectingRef.current;

        if (!nodeId || !handleType) return;

        // Check if the connection was dropped on a node (in which case React Flow handles it)
        const targetElement = (event as MouseEvent).target as HTMLElement;

        if (targetElement.closest(".react-flow__handle")) return;

        // Get screen coordinates
        const clientX = (event as MouseEvent).clientX ?? (event as TouchEvent).changedTouches?.[0]?.clientX;
        const clientY = (event as MouseEvent).clientY ?? (event as TouchEvent).changedTouches?.[0]?.clientY;

        if (clientX === undefined || clientY === undefined) return;

        setConnectionDropMenu({
            handleType,
            position: { x: clientX, y: clientY },
            sourceHandleId: handleId,
            sourceNodeId: nodeId,
        });
    };

    const handleConnectionDropSelect = (type: import("../../types").WorkflowNodeType) => {
        if (!connectionDropMenu) return;

        const flowPosition = screenToFlowPosition(connectionDropMenu.position);
        const position = { x: flowPosition.x - 140, y: flowPosition.y - 40 };
        const newNodeId = addNode(type, position, { label: i18n._(NODE_CONFIGS[type].defaultLabel) });

        // Auto-create edge between source and new node
        const { handleType, sourceHandleId, sourceNodeId } = connectionDropMenu;
        const newEdge = {
            id: `edge-${nanoid(8)}`,
            source: handleType === "source" ? sourceNodeId : newNodeId,
            sourceHandle: handleType === "source" ? sourceHandleId || "output-0" : "output-0",
            target: handleType === "source" ? newNodeId : sourceNodeId,
            targetHandle: handleType === "target" ? sourceHandleId || "input-0" : "input-0",
            type: "animated" as const,
        };

        const { edges: currentEdges } = useWorkflowStore.getState();

        setEdges([...currentEdges, newEdge]);

        selectNode(newNodeId);
        setConnectionDropMenu(null);
    };

    const onDragOver = (event: React.DragEvent) => {
        const { dataTransfer } = event;

        event.preventDefault();
        dataTransfer.dropEffect = "move";
    };

    const onDrop = (event: React.DragEvent) => {
        event.preventDefault();

        const type = event.dataTransfer.getData("application/workflow-node") as WorkflowNodeType;

        if (!type) {
            return;
        }

        // Use screenToFlowPosition for proper zoom/pan handling
        const flowPosition = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
        });

        // Offset to center the node (node width ~280, height ~80)
        const position = {
            x: flowPosition.x - 140,
            y: flowPosition.y - 40,
        };

        const nodeId = addNode(type, position, { label: i18n._(NODE_CONFIGS[type].defaultLabel) });

        selectNode(nodeId);
    };

    // Highlight the group a node is being dragged over
    const onNodeDrag = (_event: MouseEvent | TouchEvent, node: WorkflowNode) => {
        if (node.type === "group" || node.parentId) {
            setDraggingOverGroupId(null);

            return;
        }

        const group = getIntersectingNodes(node, true).find((n) => n.type === "group");

        setDraggingOverGroupId(group?.id ?? null);
    };

    // When a non-group node is dropped on top of a group node, make it a child
    const onNodeDragStop = (_event: MouseEvent | TouchEvent, node: WorkflowNode) => {
        // Always clear the drag-over highlight
        setDraggingOverGroupId(null);

        // Only attach free (non-child, non-group) nodes to groups
        if (node.type === "group" || node.parentId) {
            return;
        }

        const intersectingGroups = getIntersectingNodes(node, true).filter((n) => n.type === "group");

        if (intersectingGroups.length === 0) {
            return;
        }

        const targetGroup = intersectingGroups[0];

        if (!targetGroup) {
            return;
        }

        const relativeX = node.position.x - targetGroup.position.x;
        const relativeY = node.position.y - targetGroup.position.y;

        // Use latest store state to compute updated nodes
        const { nodes: latestNodes, setNodes: storeSetNodes } = useWorkflowStore.getState();
        const updatedNodes = latestNodes.map((n) => (n.id === node.id ? { ...n, parentId: targetGroup.id, position: { x: relativeX, y: relativeY } } : n));

        // React Flow requires parent nodes to precede their children
        const withoutParent = updatedNodes.filter((n) => !n.parentId);
        const withParent = updatedNodes.filter((n) => n.parentId);

        storeSetNodes([...withoutParent, ...withParent]);
    };

    const onMoveEnd = (_event: unknown, viewport: { x: number; y: number; zoom: number }) => {
        setViewport(viewport);
    };

    const onPaneClick = () => {
        selectNode(null);
        onNodeSelect?.(null);
    };

    // Track cursor position on the canvas for collaboration
    const onMouseMove = (event: React.MouseEvent) => {
        if (!onCursorMove) {
            return;
        }

        const position = screenToFlowPosition({
            x: event.clientX,
            y: event.clientY,
        });

        onCursorMove(position);
    };

    const onMouseLeave = () => {
        onCursorMove?.(null);
    };

    // Track node selection changes for collaboration
    const handleNodeClick = (_event: React.MouseEvent, node: { id: string }) => {
        selectNode(node.id);
        onNodeSelect?.(node.id);
    };

    return (
        <WorkflowCollabProvider
            otherUsers={collaborators ?? []}
            startEditingNode={onStartEditingNode ?? noopStartEditing}
            stopEditingNode={onStopEditingNode ?? noopStopEditing}
        >
            <div className={`relative h-full w-full ${className ?? ""}`} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} ref={reactFlowWrapper}>
                <ReactFlow<WorkflowNode, WorkflowEdge>
                    defaultEdgeOptions={{
                        animated: true,
                        type: "animated",
                    }}
                    defaultViewport={{ x: 0, y: 0, zoom: 1 }}
                    deleteKeyCode={["Backspace", "Delete"]}
                    edges={edges}
                    edgeTypes={edgeTypes}
                    maxZoom={2}
                    minZoom={0.1}
                    multiSelectionKeyCode={["Shift", "Meta"]}
                    nodes={nodes}
                    nodeTypes={nodeTypes}
                    onConnect={onConnect}
                    onConnectEnd={onConnectEnd}
                    onConnectStart={onConnectStart}
                    onDragOver={onDragOver}
                    onDrop={onDrop}
                    onEdgesChange={onEdgesChange}
                    onMoveEnd={onMoveEnd}
                    onNodeClick={handleNodeClick}
                    onNodeDrag={onNodeDrag}
                    onNodeDragStop={onNodeDragStop}
                    onNodesChange={onNodesChange}
                    onPaneClick={onPaneClick}
                    // Pan mode: left-drag pans; Select mode: left-drag box-selects, middle/right pans
                    panOnDrag={canvasMode === "pan" ? true : [1, 2]}
                    panOnScroll
                    proOptions={{ hideAttribution: true }}
                    selectionOnDrag={canvasMode === "select"}
                    snapGrid={[16, 16]}
                    snapToGrid
                    zoomOnDoubleClick={false}
                >
                    <Background color="var(--border)" gap={16} size={1} />
                    <MiniMap
                        className="!bg-background !border-border"
                        maskColor="rgba(0, 0, 0, 0.1)"
                        nodeColor={(node) => NODE_CONFIGS[node.type as WorkflowNodeType]?.color ?? "#6366f1"}
                    />
                </ReactFlow>

                {/* Collaborator cursors overlay */}
                {collaborators && collaborators.length > 0 && <CollaboratorCursors users={collaborators} />}

                {/* Floating toolbar */}
                <WorkflowToolbar />

                {/* Floating controls */}
                <WorkflowControls
                    onRun={onRun}
                    onSave={onSave}
                    onShowShortcuts={() => setShowShortcuts(true)}
                    onToggleHistory={() => setShowHistory((v) => !v)}
                    showHistory={showHistory}
                />

                {/* Execution history panel */}
                {showHistory && <ExecutionHistoryPanel onClose={() => setShowHistory(false)} />}

                {/* Bottom toolbar: zoom + interaction mode */}
                <WorkflowBottomToolbar />

                {/* Connection drop menu */}
                {connectionDropMenu && (
                    <ConnectionDropMenu
                        onClose={() => setConnectionDropMenu(null)}
                        onSelect={handleConnectionDropSelect}
                        position={connectionDropMenu.position}
                        sourceNodeType={nodes.find((n) => n.id === connectionDropMenu.sourceNodeId)?.type as WorkflowNodeType | undefined}
                    />
                )}

                {/* Keyboard shortcuts help dialog */}
                <KeyboardShortcutsDialog onClose={() => setShowShortcuts(false)} open={showShortcuts} />

                {/* Node search / command palette */}
                <NodeSearchDialog onClose={() => setShowNodeSearch(false)} open={showNodeSearch} />
            </div>
        </WorkflowCollabProvider>
    );
};

const WorkflowCanvas = (props: WorkflowCanvasProps) => (
    <ReactFlowProvider>
        <WorkflowCanvasInner {...props} />
    </ReactFlowProvider>
);

export default WorkflowCanvas;
