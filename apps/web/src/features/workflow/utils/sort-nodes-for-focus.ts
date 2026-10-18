export interface FocusOrderNode {
    id: string;
    parentId?: string;
    position: { x: number; y: number };
}

/**
 * Orders nodes for DOM and keyboard focus: top to bottom, then left to right.
 *
 * React Flow needs every parent ahead of its children, so a child is placed right after
 * its parent's first appearance. A child's `position` is relative to its parent, so its
 * sort key is the parent's position plus its own.
 *
 * Returns the input array itself when it is already in that order. Only the array handed
 * to React Flow changes: the store keeps its own order.
 */
export const sortNodesForFocus = <T extends FocusOrderNode>(nodes: T[]): T[] => {
    const byId = new Map(nodes.map((node) => [node.id, node]));

    // ponytail: one level of nesting (the canvas only nests free nodes under a group); deeper trees still get parent-first.
    const absolute = (node: T) => {
        const parent = node.parentId ? byId.get(node.parentId) : undefined;

        return parent ? { x: parent.position.x + node.position.x, y: parent.position.y + node.position.y } : node.position;
    };

    // toSorted is stable, so equal keys keep their input order.
    const sorted = nodes.toSorted((a, b) => {
        const pa = absolute(a);
        const pb = absolute(b);

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
