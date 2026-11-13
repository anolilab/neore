import { replaceEqualDeep } from "@tanstack/react-query";

import type { BranchNode } from "../types";

/** The nodes a build made, by thread id: the next build reuses the equal ones. */
export type NodesById = ReadonlyMap<string, BranchNode>;

/**
 * Structural sharing for the sidebar's thread nodes, matched by thread id.
 *
 * The list rebuilds every node whenever anything in it changes (a status, a pin, the snooze clock), and each row is memoized on its
 * node: without this, one change re-renders every row. A node equal to the one in `previousById` is that same object again; a
 * changed one still reuses its unchanged parts (children, tags).
 *
 * Pure: it reads `previousById` and returns the map for the next build. The caller passes the map of the build that was COMMITTED
 * and replaces it only once this build commits, so a render React throws away cannot change what later renders compare against.
 */
export const shareUnchangedNodes = (previousById: NodesById, lists: ReadonlyArray<ReadonlyArray<BranchNode>>): { byId: NodesById; lists: BranchNode[][] } => {
    const byId = new Map<string, BranchNode>();
    const shared = lists.map((list) =>
        list.map((node) => {
            const before = previousById.get(node.threadId);
            const result = before === undefined ? node : (replaceEqualDeep(before, node) as BranchNode);

            byId.set(node.threadId, result);

            return result;
        }),
    );

    return { byId, lists: shared };
};
