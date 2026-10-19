import { describe, expect, it } from "vitest";

import { sortNodesForFocus } from "./sort-nodes-for-focus";

const node = (id: string, x: number, y: number, parentId?: string) => {
    return { id, parentId, position: { x, y } };
};

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

describe("sortNodesForFocus", () => {
    it("orders top to bottom, then left to right", () => {
        const nodes = [node("c", 0, 200), node("b", 300, 0), node("a", 0, 0), node("d", 100, 200)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["a", "b", "c", "d"]);
    });

    it("keeps input order for nodes at the same position", () => {
        const nodes = [node("first", 5, 5), node("second", 5, 5), node("third", 5, 5)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["first", "second", "third"]);
    });

    it("returns the same array when it is already ordered", () => {
        const nodes = [node("a", 0, 0), node("b", 10, 0), node("c", 0, 10)];

        expect(sortNodesForFocus(nodes)).toBe(nodes);
    });

    it("does not mutate the input array", () => {
        const nodes = [node("b", 0, 10), node("a", 0, 0)];

        sortNodesForFocus(nodes);

        expect(ids(nodes)).toEqual(["b", "a"]);
    });

    it("places a parent before its children even when a child sorts higher", () => {
        // The child's absolute position is (10, 300), so it ties its group's row and sorts after the group by x.
        // Parent-first must hold even if the input lists the child first.
        const nodes = [node("child", 10, 0, "group"), node("free", 0, 100), node("group", 0, 300)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["free", "group", "child"]);
    });

    it("sorts a child by its absolute position, not its position relative to the parent", () => {
        // The child's own position (0, 0) would put it first, but inside the group at y=200 it sits below the free node at y=100.
        const nodes = [node("child", 0, 0, "group"), node("group", 0, 200), node("free", 0, 100)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["free", "group", "child"]);
    });

    it("keeps a parent before each of its children", () => {
        const nodes = [node("k1", 0, 50, "g"), node("k2", 0, 40, "g"), node("g", 0, 500)];

        const sorted = ids(sortNodesForFocus(nodes));

        expect(sorted.indexOf("g")).toBeLessThan(sorted.indexOf("k1"));
        expect(sorted.indexOf("g")).toBeLessThan(sorted.indexOf("k2"));
        expect(sorted).toHaveLength(3);
    });

    it("sums the whole parent chain, so a node in a nested group sorts by its real position", () => {
        // inner is at 100 + 200 = 300 and leaf at 310, so leaf sorts after free (250).
        // Summing only its direct parent would give leaf 210, which sorts it above free.
        const nodes = [node("leaf", 0, 10, "inner"), node("inner", 0, 200, "outer"), node("outer", 0, 100), node("free", 0, 250)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["outer", "free", "inner", "leaf"]);
    });

    it("keeps every ancestor before its descendants in a nested group", () => {
        const nodes = [node("leaf", 0, 0, "inner"), node("inner", 0, 0, "outer"), node("outer", 0, 500)];

        expect(ids(sortNodesForFocus(nodes))).toEqual(["outer", "inner", "leaf"]);
    });

    it("treats a parent reference to a missing node as a free node", () => {
        const nodes = [node("orphan", 0, 0, "gone"), node("a", 0, 10)];

        expect(sortNodesForFocus(nodes)).toBe(nodes);
    });

    it("terminates on a parent cycle", () => {
        const nodes = [node("a", 0, 0, "b"), node("b", 0, 10, "a")];

        expect(ids(sortNodesForFocus(nodes))).toHaveLength(2);
    });
});
