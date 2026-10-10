import { describe, expect, it } from "vitest";

import type { FlatPage } from "./page-tree";
import { buildPageTree, dropTarget, isInSubtree, menuMoves } from "./page-tree";

const page = (id: string, parentPageId: string | null, order: number): FlatPage => {
    return { _id: id, icon: null, isFavorite: false, isPublic: false, order, parentPageId, title: id, updatedAt: 0 };
};

// a (b (d), c) ; e
const pages = [page("c", "a", 2), page("a", null, 1), page("b", "a", 1), page("d", "b", 1), page("e", null, 2)];

describe("buildPageTree", () => {
    it("nests by parent and orders siblings", () => {
        const tree = buildPageTree(pages);

        expect(tree.map((node) => node._id)).toEqual(["a", "e"]);
        const [first] = tree;
        const [firstChild] = first?.children ?? [];

        expect(first?.children.map((node) => node._id)).toEqual(["b", "c"]);

        expect(firstChild?.children.at(0)).toMatchObject({ _id: "d", depth: 2 });
    });

    it("lifts an orphan to the top level", () => {
        expect(buildPageTree([page("x", "missing", 1)]).map((node) => node._id)).toEqual(["x"]);
    });

    it("does not loop on a cycle in the data", () => {
        expect(buildPageTree([page("x", "y", 1), page("y", "x", 1)])).toEqual([]);
    });
});

describe("moves", () => {
    it("knows a page's subtree", () => {
        expect(isInSubtree(pages, "a", "d")).toBe(true);
        expect(isInSubtree(pages, "b", "c")).toBe(false);
    });

    it("refuses a drop into the page's own subtree", () => {
        expect(dropTarget(pages, "a", "d", "inside")).toBeNull();
        expect(dropTarget(pages, "a", "a", "after")).toBeNull();
        expect(dropTarget(pages, "d", "e", "inside")).toEqual({ index: 0, parentPageId: "e" });
        expect(dropTarget(pages, "e", "b", "before")).toEqual({ index: 0, parentPageId: "a" });
    });

    it("offers only the menu moves that apply", () => {
        expect(menuMoves(pages, "b")).toEqual({
            down: { index: 1, parentPageId: "a" },
            indent: null,
            outdent: { index: 1, parentPageId: null },
            up: null,
        });
        expect(menuMoves(pages, "c").indent).toEqual({ index: 1, parentPageId: "b" });
        expect(menuMoves(pages, "e").outdent).toBeNull();
    });
});
