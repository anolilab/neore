export interface FocusOrderNode {
    /** Set by React Flow while a pointer drag runs on the node. */
    dragging?: boolean;
    id: string;
    parentId?: string;
    position: { x: number; y: number };
}

/**
 * Orders nodes for DOM and keyboard focus: top to bottom, then left to right.
 *
 * React Flow needs every parent ahead of its children, so a child is placed right after
 * its parent's first appearance. A child's `position` is relative to its parent, and a
 * group can sit inside another group, so its sort key is the sum of its own position and
 * every ancestor's.
 *
 * Returns the input array itself when it is already in that order. Only the array handed
 * to React Flow changes: the store keeps its own order.
 */
export const sortNodesForFocus = <T extends FocusOrderNode>(nodes: T[]): T[] => {
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // `seen` stops a parentId cycle, which has no position to sum to.
    const absolute = (node: T) => {
        let { x, y } = node.position;
        const seen = new Set([node.id]);
        let parent = node.parentId ? byId.get(node.parentId) : undefined;

        while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            x += parent.position.x;
            y += parent.position.y;
            parent = parent.parentId ? byId.get(parent.parentId) : undefined;
        }

        return { x, y };
    };

    const keys = new Map(nodes.map((node) => [node.id, absolute(node)]));

    // toSorted is stable, so equal keys keep their input order.
    const sorted = nodes.toSorted((a, b) => {
        const pa = keys.get(a.id) ?? { x: 0, y: 0 };
        const pb = keys.get(b.id) ?? { x: 0, y: 0 };

        return pa.y - pb.y || pa.x - pb.x;
    });

    const placed = new Set<T>();
    const ordered: T[] = [];

    // Marked before recursing so a parentId cycle terminates instead of looping.
    const place = (node: T) => {
        if (placed.has(node)) {
            return;
        }

        placed.add(node);

        const parent = node.parentId ? byId.get(node.parentId) : undefined;

        if (parent) {
            place(parent);
        }

        ordered.push(node);
    };

    for (const node of sorted) {
        place(node);
    }

    return ordered.every((node, index) => node === nodes[index]) ? nodes : ordered;
};
