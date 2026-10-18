import { describe, expect, it } from "vitest";

import { absolutePositionOf } from "./node-position";

const at = (id: string, x: number, y: number, parentId?: string) => {
    return { id, parentId, position: { x, y } };
};

describe("absolutePositionOf", () => {
    it("is the node's own position when it has no parent", () => {
        expect(absolutePositionOf([at("v", 10, 20)], "v")).toEqual({ x: 10, y: 20 });
    });

    it("adds the offsets of every ancestor group", () => {
        const nodes = [at("outer", 100, 200), at("inner", 10, 20, "outer"), at("v", 1, 2, "inner")];

        expect(absolutePositionOf(nodes, "v")).toEqual({ x: 111, y: 222 });
    });

    it("stops at a missing parent and at a loop, and returns the origin for an unknown node", () => {
        expect(absolutePositionOf([at("v", 5, 5, "gone")], "v")).toEqual({ x: 5, y: 5 });
        expect(absolutePositionOf([at("a", 1, 1, "b"), at("b", 2, 2, "a")], "a")).toEqual({ x: 3, y: 3 });
        expect(absolutePositionOf([], "x")).toEqual({ x: 0, y: 0 });
    });
});
