import type { WorkflowNode } from "../types";

/**
 * A node's position on the canvas. React Flow stores a grouped node's position relative to its parent,
 * so the offsets of every ancestor are added up. A parent chain that loops or names a missing node stops there.
 */
export const absolutePositionOf = (nodes: ReadonlyArray<Pick<WorkflowNode, "id" | "parentId" | "position">>, nodeId: string): { x: number; y: number } => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const seen = new Set<string>();
    let x = 0;
    let y = 0;
    let current = byId.get(nodeId);

    while (current && !seen.has(current.id)) {
        seen.add(current.id);
        x += current.position.x;
        y += current.position.y;
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }

    return { x, y };
};
