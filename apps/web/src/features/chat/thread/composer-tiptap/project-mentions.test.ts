import { describe, expect, it } from "vitest";

import { partitionByProject, projectThreadIds } from "./project-mentions";

const rows = [{ _id: "a", projectId: "p1" }, { _id: "b", projectId: "p1" }, { _id: "c", projectId: "p2" }, { _id: "d" }];

describe(projectThreadIds, () => {
    it("returns the chats sharing the current chat's project", () => {
        expect([...projectThreadIds(rows, "a")]).toStrictEqual(["a", "b"]);
    });

    it("is empty when the current chat has no project or is not loaded", () => {
        expect(projectThreadIds(rows, "d").size).toBe(0);
        expect(projectThreadIds(rows, "missing").size).toBe(0);
        expect(projectThreadIds(rows).size).toBe(0);
    });
});

describe(partitionByProject, () => {
    it("keeps each side in its original order", () => {
        expect(partitionByProject([1, 2, 3, 4, 5], (n) => n % 2 === 0)).toStrictEqual({ inProject: [2, 4], rest: [1, 3, 5] });
    });
});
