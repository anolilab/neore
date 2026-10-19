import { useMemo } from "react";

import type { FocusOrderNode } from "../utils/sort-nodes-for-focus";
import { sortNodesForFocus } from "../utils/sort-nodes-for-focus";

/**
 * `nodes` in focus order, recomputed only when nodes are added, removed or
 * re-parented, and when a pointer drag starts or ends. A position-only change
 * (a keyboard move, a collaborator's drag) keeps the order it had: React moves a
 * reordered DOM node with `insertBefore`, which blurs it, and a user arrow-keying
 * a focused node past a neighbour would lose focus mid-move. A pointer drag is
 * recomputed on release, once the node is where the user dropped it.
 */
export const useFocusOrderedNodes = <T extends FocusOrderNode>(nodes: T[]): T[] => {
    const structure = nodes.map((node) => `${node.id}:${node.parentId ?? ""}`).join("|");
    // Keyboard moves never set `dragging`, so they stay out of the key, as they should.
    const dragging = nodes.some((node) => node.dragging === true);

    // `structure` and `dragging` are the only inputs that may reorder; the sort reads positions as of the render it changes in.
    const order = useMemo(() => sortNodesForFocus(nodes).map((node) => node.id), [structure, dragging]);

    // A new array on every render would make React Flow re-adopt every node, so the array is kept while its inputs are.
    return useMemo(() => {
        const byId = new Map(nodes.map((node) => [node.id, node]));

        return order.flatMap((id) => {
            const node = byId.get(id);

            return node ? [node] : [];
        });
    }, [nodes, order]);
};
