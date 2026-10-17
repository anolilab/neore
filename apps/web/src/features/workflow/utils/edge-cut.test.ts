import { getBezierPath, Position } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import { edgesCrossedBy, sampleBezierPath, segmentsIntersect } from "./edge-cut";

const p = (x: number, y: number) => {
    return { x, y };
};

describe("segmentsIntersect", () => {
    it("detects a proper crossing and misses parallel or disjoint segments", () => {
        expect(segmentsIntersect(p(0, 0), p(10, 10), p(0, 10), p(10, 0))).toBe(true);
        expect(segmentsIntersect(p(0, 0), p(10, 0), p(0, 5), p(10, 5))).toBe(false);
        expect(segmentsIntersect(p(0, 0), p(1, 1), p(5, 0), p(6, -1))).toBe(false);
    });

    it("counts touching at an endpoint and collinear overlap as intersecting", () => {
        expect(segmentsIntersect(p(0, 0), p(10, 0), p(10, 0), p(10, 5))).toBe(true);
        expect(segmentsIntersect(p(0, 0), p(10, 0), p(5, 0), p(15, 0))).toBe(true);
        expect(segmentsIntersect(p(0, 0), p(4, 0), p(5, 0), p(15, 0))).toBe(false);
    });
});

describe("sampleBezierPath and edgesCrossedBy", () => {
    // The path xyflow renders for a left-to-right edge, so the test fails if its format changes.
    const bezier = (sourceX: number, sourceY: number, targetX: number, targetY: number) =>
        getBezierPath({ sourcePosition: Position.Right, sourceX, sourceY, targetPosition: Position.Left, targetX, targetY })[0];
    const straightEdge = bezier(0, 0, 100, 100);

    it("samples the endpoints of the cubic and fails closed on another path shape", () => {
        const points = sampleBezierPath(straightEdge, 4);

        expect(points[0]).toEqual(p(0, 0));
        expect(points[4]).toEqual(p(100, 100));
        expect(sampleBezierPath("M0,0 L10,10")).toEqual([]);
    });

    it("returns only the edges the cut line crosses", () => {
        const crossing = { id: "hit", points: sampleBezierPath(straightEdge) };
        const elsewhere = { id: "miss", points: sampleBezierPath(bezier(0, 500, 100, 600)) };

        // A vertical cut at x=30 crosses the first edge (its y spans 0..100) but not the second.
        expect(edgesCrossedBy([p(30, -10), p(30, 200)], [crossing, elsewhere])).toEqual(["hit"]);
    });
});
