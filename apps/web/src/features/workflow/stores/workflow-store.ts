import type { Connection, OnConnect, OnEdgesChange, OnNodesChange, Viewport } from "@xyflow/react";
import { addEdge, applyEdgeChanges, applyNodeChanges } from "@xyflow/react";
import { nanoid } from "nanoid";
import { create } from "zustand";
import { subscribeWithSelector } from "zustand/middleware";

import type { NodeExecutionStatus, WorkflowContent, WorkflowEdge, WorkflowExecutionState, WorkflowNode, WorkflowNodeData, WorkflowNodeType } from "../types";
import NODE_CONFIGS from "../types";

interface WorkflowState {
    // Actions - Node CRUD
    addNode: (type: WorkflowNodeType, position: { x: number; y: number }, data?: Partial<WorkflowNodeData>) => string;

    // Interaction mode
    canvasMode: "select" | "pan";
    copiedEdges: WorkflowEdge[];
    copiedNodes: WorkflowNode[];

    copySelectedNodes: () => void;
    currentExecutionId: string | null;
    deleteNode: (id: string) => void;

    detachFromGroup: (nodeId: string) => void;
    // Drag-over group highlight
    draggingOverGroupId: string | null;

    duplicateNode: (id: string) => void;

    edges: WorkflowEdge[];
    // Execution state
    execution: WorkflowExecutionState;

    getContent: () => WorkflowContent;
    // Actions - Grouping
    /** `label` is the (already translated) name for the new group; defaults to "Group". */
    groupNodes: (nodeIds: string[], label?: string) => string;

    // Dirty state for save indicator
    isDirty: boolean;

    // Actions - Content
    loadContent: (content: WorkflowContent | null) => void;
    // Canvas state
    nodes: WorkflowNode[];
    onConnect: OnConnect;
    onEdgesChange: OnEdgesChange<WorkflowEdge>;
    onNodesChange: OnNodesChange<WorkflowNode>;
    pasteNodes: (position?: { x: number; y: number }) => void;
    // Project/workflow ID
    projectId: string | null;

    reset: () => void;
    resetExecution: () => void;
    // Selection state
    selectedNodeId: string | null;
    // Actions - Selection
    selectNode: (id: string | null) => void;

    setCanvasMode: (mode: "select" | "pan") => void;
    setCurrentExecutionId: (executionId: string | null) => void;
    setDirty: (isDirty: boolean) => void;

    setDraggingOverGroupId: (id: string | null) => void;
    setEdges: (edges: WorkflowEdge[]) => void;
    // Actions - Execution
    setExecutionStatus: (status: WorkflowExecutionState["status"]) => void;

    setNodeExecutionStatus: (
        nodeId: string,
        status: NodeExecutionStatus,
        data?: { error?: string; input?: unknown; output?: unknown; usage?: { completionTokens: number; promptTokens: number; totalTokens: number } },
    ) => void;
    setNodes: (nodes: WorkflowNode[]) => void;
    // Actions - Canvas
    setProjectId: (projectId: string | null) => void;
    setViewport: (viewport: Viewport) => void;

    ungroupNode: (groupId: string) => void;
    updateNode: (id: string, data: Partial<WorkflowNodeData>) => void;
    // Style actions (for auto-resize)
    updateNodeStyle: (id: string, style: { height?: number; width?: number }) => void;
    viewport: Viewport;
}

const initialExecutionState: WorkflowExecutionState = {
    nodeStates: {},
    status: "idle",
};

const initialViewport: Viewport = { x: 0, y: 0, zoom: 1 };

export const useWorkflowStore = create<WorkflowState>()(
    subscribeWithSelector((set, get) => {
        return {
            // Node CRUD actions
            addNode: (type, position, data) => {
                const id = `node-${nanoid(8)}`;
                const config = NODE_CONFIGS[type];

                const newNode: WorkflowNode = {
                    data: {
                        ...config.defaultData,
                        ...data,
                    } as WorkflowNodeData,
                    id,
                    position,
                    type,
                    // Group nodes need an initial size so they render as a container
                    ...(type === "group" && { style: { height: 300, width: 400 } }),
                };

                // Group nodes must precede their children; add at front if necessary
                const nodes = type === "group" ? [newNode, ...get().nodes] : [...get().nodes, newNode];

                set({ isDirty: true, nodes });

                return id;
            },
            canvasMode: "select",
            copiedEdges: [],
            copiedNodes: [],
            copySelectedNodes: () => {
                const { edges, nodes, selectedNodeId } = get();

                if (!selectedNodeId) {
                    return;
                }

                const nodesToCopy = nodes.filter((n) => n.id === selectedNodeId);
                const nodeIds = new Set(nodesToCopy.map((n) => n.id));
                const edgesToCopy = edges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

                set({
                    copiedEdges: edgesToCopy,
                    copiedNodes: nodesToCopy,
                });
            },
            currentExecutionId: null,
            deleteNode: (id) => {
                const state = get();
                // Also delete children when deleting a group node
                const childIds = state.nodes.flatMap((n) => (n.parentId === id ? [n.id] : []));
                const idsToDelete = new Set([id, ...childIds]);

                set({
                    edges: state.edges.filter((edge) => !idsToDelete.has(edge.source) && !idsToDelete.has(edge.target)),
                    isDirty: true,
                    nodes: state.nodes.filter((node) => !idsToDelete.has(node.id)),
                    selectedNodeId: idsToDelete.has(state.selectedNodeId ?? "") ? null : state.selectedNodeId,
                });
            },
            detachFromGroup: (nodeId) => {
                const state = get();
                const node = state.nodes.find((n) => n.id === nodeId);

                if (!node?.parentId) {
                    return;
                }

                const parentNode = state.nodes.find((n) => n.id === node.parentId);

                if (!parentNode) {
                    return;
                }

                const updatedNodes = state.nodes.map((n) => {
                    if (n.id === nodeId) {
                        return {
                            ...n,
                            parentId: undefined,
                            position: {
                                x: n.position.x + parentNode.position.x,
                                y: n.position.y + parentNode.position.y,
                            },
                        };
                    }

                    return n;
                });

                set({ isDirty: true, nodes: updatedNodes });
            },
            draggingOverGroupId: null,
            duplicateNode: (id) => {
                const node = get().nodes.find((n) => n.id === id);

                if (!node) {
                    return;
                }

                const newId = `node-${nanoid(8)}`;
                const newNode: WorkflowNode = {
                    ...node,
                    id: newId,
                    position: {
                        x: node.position.x + 50,
                        y: node.position.y + 50,
                    },
                };

                set({
                    isDirty: true,
                    nodes: [...get().nodes, newNode],
                    selectedNodeId: newId,
                });
            },

            edges: [],
            execution: initialExecutionState,

            getContent: () => {
                return {
                    edges: get().edges,
                    nodes: get().nodes,
                    viewport: get().viewport,
                };
            },
            groupNodes: (nodeIds, label) => {
                const state = get();
                const nodeIdSet = new Set(nodeIds);
                const nodesToGroup = state.nodes.filter((n) => nodeIdSet.has(n.id) && n.type !== "group" && !n.parentId);

                if (nodesToGroup.length < 2) {
                    return "";
                }

                const PADDING = 40;
                const minX = Math.min(...nodesToGroup.map((n) => n.position.x));
                const minY = Math.min(...nodesToGroup.map((n) => n.position.y));
                const maxX = Math.max(...nodesToGroup.map((n) => n.position.x + (n.measured?.width ?? 280)));
                const maxY = Math.max(...nodesToGroup.map((n) => n.position.y + (n.measured?.height ?? 100)));

                const groupX = minX - PADDING;
                const groupY = minY - PADDING;
                const groupWidth = maxX - minX + PADDING * 2;
                const groupHeight = maxY - minY + PADDING * 2;

                const groupId = `node-${nanoid(8)}`;
                const groupNode: WorkflowNode = {
                    data: { label: label ?? "Group" } as WorkflowNodeData,
                    id: groupId,
                    position: { x: groupX, y: groupY },
                    selected: false,
                    style: { height: groupHeight, width: groupWidth },
                    type: "group",
                };

                const nodeIdsSet = new Set(nodeIds);
                // Group node must precede its children in the array
                const updatedNodes = [
                    groupNode,
                    ...state.nodes.map((n) => {
                        if (nodeIdsSet.has(n.id) && n.type !== "group" && !n.parentId) {
                            return {
                                ...n,
                                parentId: groupId,
                                position: {
                                    x: n.position.x - groupX,
                                    y: n.position.y - groupY,
                                },
                                selected: false,
                            };
                        }

                        return n;
                    }),
                ];

                set({ isDirty: true, nodes: updatedNodes, selectedNodeId: null });

                return groupId;
            },

            isDirty: false,

            // Content actions
            loadContent: (content) => {
                if (content) {
                    set({
                        edges: content.edges,
                        isDirty: false,
                        nodes: content.nodes,
                        viewport: content.viewport ?? initialViewport,
                    });
                } else {
                    set({
                        edges: [],
                        isDirty: false,
                        nodes: [],
                        viewport: initialViewport,
                    });
                }
            },

            nodes: [],

            onConnect: (connection: Connection) => {
                set({
                    edges: addEdge(
                        {
                            ...connection,
                            id: `edge-${nanoid(8)}`,
                            type: "animated",
                        },
                        get().edges,
                    ),
                    isDirty: true,
                });
            },

            onEdgesChange: (changes) => {
                set({
                    edges: applyEdgeChanges(changes, get().edges),
                    isDirty: true,
                });
            },

            onNodesChange: (changes) => {
                const newNodes = applyNodeChanges(changes, get().nodes);
                // Remove orphaned children whose parent group was deleted (avoids extra
                // removal changes that can cause React Flow nested-update warnings).
                const existingIds = new Set(newNodes.map((n) => n.id));
                const clean = newNodes.filter((n) => !n.parentId || existingIds.has(n.parentId));

                set({ isDirty: true, nodes: clean });
            },

            pasteNodes: (position) => {
                const { copiedEdges, copiedNodes, nodes } = get();

                if (copiedNodes.length === 0) {
                    return;
                }

                const idMapping = new Map<string, string>();
                const offset = position ?? { x: 50, y: 50 };

                const newNodes = copiedNodes.map((node) => {
                    const newId = `node-${nanoid(8)}`;

                    idMapping.set(node.id, newId);

                    return {
                        ...node,
                        id: newId,
                        position: {
                            x: node.position.x + offset.x,
                            y: node.position.y + offset.y,
                        },
                    };
                });

                const newEdges = copiedEdges.map((edge) => {
                    return {
                        ...edge,
                        id: `edge-${nanoid(8)}`,
                        source: idMapping.get(edge.source) ?? edge.source,
                        target: idMapping.get(edge.target) ?? edge.target,
                    };
                });

                set({
                    edges: [...get().edges, ...newEdges],
                    isDirty: true,
                    nodes: [...nodes, ...newNodes],
                    selectedNodeId: newNodes[0]?.id ?? null,
                });
            },

            // Initial state
            projectId: null,

            reset: () =>
                set({
                    copiedEdges: [],
                    copiedNodes: [],
                    currentExecutionId: null,
                    edges: [],
                    execution: initialExecutionState,
                    isDirty: false,
                    nodes: [],
                    projectId: null,
                    selectedNodeId: null,
                    viewport: initialViewport,
                }),

            resetExecution: () => {
                set({ currentExecutionId: null, execution: initialExecutionState });
            },

            selectedNodeId: null,

            // Selection actions
            selectNode: (id) => set({ selectedNodeId: id }),

            // Grouping actions

            setCanvasMode: (canvasMode) => set({ canvasMode }),

            setCurrentExecutionId: (executionId) => {
                set({ currentExecutionId: executionId });
            },

            setDirty: (isDirty) => set({ isDirty }),

            setDraggingOverGroupId: (draggingOverGroupId) => set({ draggingOverGroupId }),

            setEdges: (edges) => set({ edges, isDirty: true }),

            // Execution actions
            setExecutionStatus: (status) => {
                set({
                    execution: {
                        ...get().execution,
                        completedAt: status === "completed" || status === "failed" ? Date.now() : undefined,
                        startedAt: status === "running" ? Date.now() : get().execution.startedAt,
                        status,
                    },
                });
            },

            setNodeExecutionStatus: (nodeId, status, data) => {
                set({
                    execution: {
                        ...get().execution,
                        nodeStates: {
                            ...get().execution.nodeStates,
                            [nodeId]: {
                                ...get().execution.nodeStates[nodeId],
                                completedAt: status === "completed" || status === "failed" ? Date.now() : undefined,
                                error: data?.error,
                                input: data?.input ?? get().execution.nodeStates[nodeId]?.input,
                                output: data?.output ?? get().execution.nodeStates[nodeId]?.output,
                                startedAt: status === "running" ? Date.now() : get().execution.nodeStates[nodeId]?.startedAt,
                                status,
                                usage: data?.usage ?? get().execution.nodeStates[nodeId]?.usage,
                            },
                        },
                    },
                });
            },

            setNodes: (nodes) => set({ isDirty: true, nodes }),

            // Canvas actions
            setProjectId: (projectId) => set({ projectId }),

            setViewport: (viewport) => set({ viewport }),

            ungroupNode: (groupId) => {
                const state = get();
                const groupNode = state.nodes.find((n) => n.id === groupId);

                if (!groupNode || groupNode.type !== "group") {
                    return;
                }

                const updatedNodes = state.nodes.flatMap((n) => {
                    if (n.id === groupId) {
                        return [];
                    }

                    if (n.parentId === groupId) {
                        return [
                            {
                                ...n,
                                parentId: undefined,
                                position: {
                                    x: n.position.x + groupNode.position.x,
                                    y: n.position.y + groupNode.position.y,
                                },
                            },
                        ];
                    }

                    return [n];
                });

                set({ isDirty: true, nodes: updatedNodes });
            },

            updateNode: (id, data) => {
                set({
                    isDirty: true,
                    nodes: get().nodes.map((node) => (node.id === id ? { ...node, data: { ...node.data, ...data } } : node)),
                });
            },

            updateNodeStyle: (id, style) =>
                set({
                    isDirty: true,
                    nodes: get().nodes.map((node) => (node.id === id ? { ...node, style: { ...node.style, ...style } } : node)),
                }),

            viewport: initialViewport,
        };
    }),
);

// Selector hooks for optimized rerenders
export const useWorkflowNodes = () => useWorkflowStore((state) => state.nodes);
export const useWorkflowEdges = () => useWorkflowStore((state) => state.edges);
export const useSelectedNode = () => useWorkflowStore((state) => state.nodes.find((n) => n.id === state.selectedNodeId));
export const useWorkflowExecution = () => useWorkflowStore((state) => state.execution);
export const useWorkflowIsDirty = () => useWorkflowStore((state) => state.isDirty);
