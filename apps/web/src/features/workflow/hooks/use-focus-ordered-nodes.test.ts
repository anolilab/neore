import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useFocusOrderedNodes } from "./use-focus-ordered-nodes";

const node = (id: string, x: number, y: number, dragging = false) => {
    return { dragging, id, position: { x, y } };
};

const ids = (nodes: { id: string }[]) => nodes.map((n) => n.id);

describe("useFocusOrderedNodes", () => {
    it("orders by position on first render", () => {
        const { result } = renderHook(() => useFocusOrderedNodes([node("b", 0, 100), node("a", 0, 0)]));

        expect(ids(result.current)).toEqual(["a", "b"]);
    });

    it("keeps the order when only positions change, but uses the new positions", () => {
        const { rerender, result } = renderHook(({ nodes }) => useFocusOrderedNodes(nodes), {
            initialProps: { nodes: [node("a", 0, 0), node("b", 0, 100)] },
        });

        rerender({ nodes: [node("a", 0, 500), node("b", 0, 100)] });

        expect(ids(result.current)).toEqual(["a", "b"]);
        expect(result.current[0]?.position.y).toBe(500);
    });

    it("keeps the order while a mouse drag runs, then re-sorts when it ends", () => {
        const { rerender, result } = renderHook(({ nodes }) => useFocusOrderedNodes(nodes), {
            initialProps: { nodes: [node("a", 0, 0), node("b", 0, 100)] },
        });

        // The drag starts with the node where it was; the moved position arrives while it is still dragging.
        rerender({ nodes: [node("a", 0, 0, true), node("b", 0, 100)] });
        rerender({ nodes: [node("a", 0, 500, true), node("b", 0, 100)] });

        expect(ids(result.current)).toEqual(["a", "b"]);

        rerender({ nodes: [node("a", 0, 500), node("b", 0, 100)] });

        expect(ids(result.current)).toEqual(["b", "a"]);
        expect(result.current[1]?.position.y).toBe(500);
    });

    it("re-sorts when a node is added", () => {
        const { rerender, result } = renderHook(({ nodes }) => useFocusOrderedNodes(nodes), {
            initialProps: { nodes: [node("a", 0, 0), node("b", 0, 100)] },
        });

        rerender({ nodes: [node("a", 0, 500), node("b", 0, 100), node("c", 0, 50)] });

        expect(ids(result.current)).toEqual(["c", "b", "a"]);
    });

    it("returns the same array while its inputs are the same", () => {
        const initial = [node("a", 0, 0), node("b", 0, 100)];
        const { rerender, result } = renderHook(({ nodes }) => useFocusOrderedNodes(nodes), { initialProps: { nodes: initial } });
        const first = result.current;

        rerender({ nodes: initial });

        expect(result.current).toBe(first);
    });

    it("drops a removed node", () => {
        const { rerender, result } = renderHook(({ nodes }) => useFocusOrderedNodes(nodes), {
            initialProps: { nodes: [node("a", 0, 0), node("b", 0, 100)] },
        });

        rerender({ nodes: [node("b", 0, 100)] });

        expect(ids(result.current)).toEqual(["b"]);
    });
});
