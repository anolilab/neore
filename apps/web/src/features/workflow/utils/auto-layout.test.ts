import { describe, expect, it } from "vitest";

import type { WorkflowNode } from "../types";
import { arrangeSelectedGrid } from "./auto-layout";

const node = (id: string, x: number, y: number, width: number, height: number, extra: Partial<WorkflowNode> = {}): WorkflowNode =>
    ({
        data: { label: id },
        id,
        measured: { height, width },
        position: { x, y },
        selected: true,
        type: "text",
        ...extra,
    }) as unknown as WorkflowNode;

const byId = (nodes: WorkflowNode[], id: string) => nodes.find((n) => n.id === id)!;

describe("arrangeSelectedGrid", () => {
    it("lays four selected nodes into a 2x2 grid with 56px gaps, centred on the selection", () => {
        const nodes = [node("a", 0, 0, 100, 50), node("b", 400, 0, 100, 50), node("c", 0, 300, 100, 50), node("d", 400, 300, 100, 50)];
        const out = arrangeSelectedGrid(nodes);
        const a = byId(out, "a").position;
        const b = byId(out, "b").position;
        const c = byId(out, "c").position;

        expect(b.x - (a.x + 100)).toBe(56);
        expect(c.y - (a.y + 50)).toBe(56);
        // Selection bounds were x 0..500, y 0..350: the grid keeps that centre.
        const d = byId(out, "d").position;

        expect((a.x + d.x + 100) / 2).toBe(250);
        expect((a.y + d.y + 50) / 2).toBe(175);
    });

    it("leaves unselected nodes, groups and grouped children where they are", () => {
        const nodes = [
            node("a", 0, 0, 100, 50),
            node("b", 300, 0, 100, 50),
            node("other", 900, 900, 100, 50, { selected: false }),
            node("group", 0, 0, 500, 500, { selected: true, type: "group" }),
            node("child", 10, 10, 100, 50, { parentId: "group", selected: true }),
        ];
        const out = arrangeSelectedGrid(nodes);

        expect(byId(out, "other").position).toEqual({ x: 900, y: 900 });
        expect(byId(out, "group").position).toEqual({ x: 0, y: 0 });
        expect(byId(out, "child").position).toEqual({ x: 10, y: 10 });
    });

    it("does nothing with fewer than two selected nodes", () => {
        const nodes = [node("a", 0, 0, 100, 50), node("b", 300, 0, 100, 50, { selected: false })];

        expect(arrangeSelectedGrid(nodes)).toBe(nodes);
    });
});
