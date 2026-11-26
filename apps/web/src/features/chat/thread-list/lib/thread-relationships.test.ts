import { describe, expect, it } from "vitest";

import { indexRelationships, nodeBranchType } from "./thread-relationships";

const relationships = [
    { branchType: "branch", parentThreadId: "parent", threadId: "branch1" },
    { branchType: "side", parentThreadId: "parent", threadId: "side1" },
];

describe("indexRelationships", () => {
    it("lists a side chat under its parent", () => {
        const { childrenMap } = indexRelationships(relationships);

        expect(childrenMap.get("parent")?.map((rel) => rel.threadId)).toEqual(["branch1", "side1"]);
    });

    it("leaves a side chat out of the top level, which holds only threads with no relationship", () => {
        const { relationshipMap } = indexRelationships(relationships);
        const roots = ["parent", "branch1", "side1", "other"].filter((id) => !relationshipMap.has(id));

        expect(roots).toEqual(["parent", "other"]);
    });

    it("ignores a link with no parent as a child", () => {
        expect(indexRelationships([{ threadId: "orphan" }]).childrenMap.size).toBe(0);
    });
});

describe("nodeBranchType", () => {
    it("tells a side chat apart and shows every other link as a branch", () => {
        expect(nodeBranchType({ branchType: "side", threadId: "a" })).toBe("side");
        expect(nodeBranchType({ branchType: "comparison", threadId: "a" })).toBe("branch");
        expect(nodeBranchType({ threadId: "a" })).toBe("branch");
    });
});
