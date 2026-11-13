import { replaceEqualDeep } from "@tanstack/react-query";

import type { BranchNode } from "../types";

/**
 * Structural sharing for the sidebar's thread nodes, matched by thread id.
 *
 * The list rebuilds every node whenever anything in it changes (a status, a pin, the snooze clock), and each row is memoized on its
 * node: without this, one change re-renders every row. A node equal to the one the last build made is that same object again; a
 * changed one still reuses its unchanged parts (children, tags). The sharer remembers only the last build, so a thread that leaves
 * the list is forgotten.
 *
 * It holds the last build between calls: create one per list (`useState(createNodeSharer)`) and call it once per build.
 * Reusing a node only ever swaps in an equal object, so a build React throws away leaves nothing wrong behind.
 */
export const createNodeSharer = (): ((lists: ReadonlyArray<ReadonlyArray<BranchNode>>) => BranchNode[][]) => {
    let previousById = new Map<string, BranchNode>();

    return (lists) => {
        const nextById = new Map<string, BranchNode>();
        const shared = lists.map((list) =>
            list.map((node) => {
                const before = previousById.get(node.threadId);
                const result = before === undefined ? node : (replaceEqualDeep(before, node) as BranchNode);

                nextById.set(node.threadId, result);

                return result;
            }),
        );

        previousById = nextById;

        return shared;
    };
};
