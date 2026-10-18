import { useMemo } from "react";

import type { FocusOrderNode } from "../utils/sort-nodes-for-focus";
import { sortNodesForFocus } from "../utils/sort-nodes-for-focus";

/**
 * `nodes` in focus order, recomputed only when nodes are added, removed or
 * re-parented. A position-only change (a keyboard move, a collaborator's drag)
 * keeps the order it had: React moves a reordered DOM node with `insertBefore`,
 * which blurs it, and a user arrow-keying a focused node past a neighbour would
 * lose focus mid-move. The order catches up on the next structural change.
 */
export const useFocusOrderedNodes = <T extends FocusOrderNode>(nodes: T[]): T[] => {
    const structure = nodes.map((node) => `${node.id}:${node.parentId ?? ""}`).join("|");

    // `structure` is the only input that may reorder; the sort reads positions as of the render it changes in.
    const order = useMemo(() => sortNodesForFocus(nodes).map((node) => node.id), [structure]);

    const byId = new Map(nodes.map((node) => [node.id, node]));

    return order.flatMap((id) => {
        const node = byId.get(id);

        return node ? [node] : [];
    });
};
