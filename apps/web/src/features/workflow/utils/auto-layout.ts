/**
 * Auto-layout utility for workflow graphs.
 *
 * Implements a simple layered (Sugiyama-style) layout:
 * 1. Assign layers via longest-path from source nodes
 * 2. Order nodes within each layer to minimize edge crossings (barycenter heuristic)
 * 3. Position nodes with configurable spacing
 *
 * Works without external dependencies (no dagre/ELK required).
 */
import type { WorkflowEdge, WorkflowNode } from "../types";

interface LayoutOptions {
    /** Layout direction */
    direction?: "LR" | "TB";
    /** Horizontal spacing between layers */
    layerGap?: number;
    /** Vertical spacing between nodes in the same layer */
    nodeGap?: number;
    /** Assumed node height for spacing */
    nodeHeight?: number;
    /** Assumed node width for spacing */
    nodeWidth?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
    direction: "LR",
    layerGap: 300,
    nodeGap: 120,
    nodeHeight: 100,
    nodeWidth: 280,
};

export function autoLayout(nodes: WorkflowNode[], edges: WorkflowEdge[], options: LayoutOptions = {}): WorkflowNode[] {
    const layoutOptions = { ...DEFAULTS, ...options };

    // Filter out group/comment nodes - they don't participate in layout
    const layoutNodes = nodes.filter((n) => n.type !== "group" && n.type !== "comment" && !n.parentId);
    const layoutNodeIds = new Set(layoutNodes.map((n) => n.id));

    // Build adjacency (only edges between layout-participating nodes)
    const forward = new Map<string, string[]>();
    const backward = new Map<string, string[]>();

    for (const id of layoutNodeIds) {
        forward.set(id, []);
        backward.set(id, []);
    }

    for (const edge of edges) {
        if (!layoutNodeIds.has(edge.source) || !layoutNodeIds.has(edge.target)) continue;

        forward.get(edge.source)!.push(edge.target);
        backward.get(edge.target)!.push(edge.source);
    }

    // ── Step 1: Assign layers using longest-path ──
    const layers = new Map<string, number>();

    // Find source nodes (no incoming edges)
    const sources = layoutNodes.filter((n) => (backward.get(n.id)?.length ?? 0) === 0);

    // If no sources (all cyclic), just pick the first node
    if (sources.length === 0 && layoutNodes.length > 0) {
        sources.push(layoutNodes[0]!);
    }

    // BFS to assign layers
    const queue: string[] = sources.map((n) => n.id);

    for (const id of queue) {
        if (!layers.has(id)) layers.set(id, 0);
    }

    // Process nodes, assigning max layer based on predecessors
    const visited = new Set<string>();
    const toProcess = [...queue];

    // Topological-ish iteration with max 100 iterations to avoid infinite loops on cycles
    let iterations = 0;

    while (toProcess.length > 0 && iterations < layoutNodes.length * 2) {
        const current = toProcess.shift()!;

        iterations += 1;

        if (visited.has(current)) continue;

        // Check all predecessors are assigned
        const preds = backward.get(current) ?? [];
        const allPredsAssigned = preds.every((p) => layers.has(p));

        if (!allPredsAssigned) {
            toProcess.push(current);
            continue;
        }

        const maxPredLayer = preds.length > 0 ? Math.max(...preds.map((p) => layers.get(p) ?? 0)) : -1;

        layers.set(current, maxPredLayer + 1);
        visited.add(current);

        const successors = forward.get(current) ?? [];

        for (const next of successors) {
            if (!visited.has(next)) {
                toProcess.push(next);
            }
        }
    }

    // Assign unvisited nodes (cycles) to layer 0
    for (const node of layoutNodes) {
        if (!layers.has(node.id)) {
            layers.set(node.id, 0);
        }
    }

    // ── Step 2: Group by layer and order by barycenter ──
    const maxLayer = Math.max(0, ...layers.values());
    const layerBuckets: string[][] = Array.from({ length: maxLayer + 1 }, () => []);

    for (const [id, layer] of layers) {
        layerBuckets[layer]!.push(id);
    }

    // Barycenter ordering: order nodes by the average position of their predecessors
    for (let l = 1; l <= maxLayer; l += 1) {
        const bucket = layerBuckets[l]!;
        const previousBucket = layerBuckets[l - 1]!;
        const previousPositions = new Map(previousBucket.map((id, index) => [id, index]));

        bucket.sort((a, b) => {
            const predsA = (backward.get(a) ?? []).filter((p) => previousPositions.has(p));
            const predsB = (backward.get(b) ?? []).filter((p) => previousPositions.has(p));
            const baryA = predsA.length > 0 ? predsA.reduce((s, p) => s + (previousPositions.get(p) ?? 0), 0) / predsA.length : 0;
            const baryB = predsB.length > 0 ? predsB.reduce((s, p) => s + (previousPositions.get(p) ?? 0), 0) / predsB.length : 0;

            return baryA - baryB;
        });
    }

    // ── Step 3: Assign positions ──
    const positions = new Map<string, { x: number; y: number }>();

    for (let l = 0; l <= maxLayer; l += 1) {
        const bucket = layerBuckets[l]!;
        const totalHeight = bucket.length * layoutOptions.nodeHeight + (bucket.length - 1) * layoutOptions.nodeGap;
        const startY = -totalHeight / 2;

        for (const [i, element] of bucket.entries()) {
            const id = element!;

            if (layoutOptions.direction === "LR") {
                positions.set(id, {
                    x: l * (layoutOptions.nodeWidth + layoutOptions.layerGap),
                    y: startY + i * (layoutOptions.nodeHeight + layoutOptions.nodeGap),
                });
            } else {
                positions.set(id, {
                    x: startY + i * (layoutOptions.nodeWidth + layoutOptions.nodeGap),
                    y: l * (layoutOptions.nodeHeight + layoutOptions.layerGap),
                });
            }
        }
    }

    // ── Step 4: Apply positions ──
    return nodes.map((node) => {
        const pos = positions.get(node.id);

        if (pos) {
            return { ...node, position: pos };
        }

        return node;
    });
}
