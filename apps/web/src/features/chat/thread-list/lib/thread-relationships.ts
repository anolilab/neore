import type { MinimalThreadRelationship } from "../types";

/** The relationships of a thread list, by child and by parent. Every linked thread, a side chat included, is a child: none is a root. */
export const indexRelationships = (relationships: ReadonlyArray<MinimalThreadRelationship>) => {
    const relationshipMap = new Map<string, MinimalThreadRelationship>(relationships.map((rel) => [rel.threadId, rel]));
    const childrenMap = new Map<string, MinimalThreadRelationship[]>();

    for (const rel of relationships) {
        if (!rel.parentThreadId) {
            continue;
        }

        const existing = childrenMap.get(rel.parentThreadId);

        if (existing) {
            existing.push(rel);
        } else {
            childrenMap.set(rel.parentThreadId, [rel]);
        }
    }

    return { childrenMap, relationshipMap };
};

/** What a child row is: a side chat is told apart, every other link shows as a branch, as it always has. */
export const nodeBranchType = (rel: MinimalThreadRelationship): string => (rel.branchType === "side" ? "side" : "branch");
