/** Geometry for the edge cut gesture: which edges a drawn line crosses. Pure, so it is tested without a canvas. */

export interface Point {
    x: number;
    y: number;
}

const orientation = (a: Point, b: Point, c: Point): number => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));

const onSegment = (a: Point, b: Point, p: Point): boolean =>
    Math.min(a.x, b.x) <= p.x && p.x <= Math.max(a.x, b.x) && Math.min(a.y, b.y) <= p.y && p.y <= Math.max(a.y, b.y);

/** Whether segment p1-p2 touches segment q1-q2, including touching at an end or overlapping. */
export const segmentsIntersect = (p1: Point, p2: Point, q1: Point, q2: Point): boolean => {
    const o1 = orientation(p1, p2, q1);
    const o2 = orientation(p1, p2, q2);
    const o3 = orientation(q1, q2, p1);
    const o4 = orientation(q1, q2, p2);

    if (o1 !== o2 && o3 !== o4) return true;

    if (o1 === 0 && onSegment(p1, p2, q1)) return true;

    if (o2 === 0 && onSegment(p1, p2, q2)) return true;

    if (o3 === 0 && onSegment(q1, q2, p1)) return true;

    if (o4 === 0 && onSegment(q1, q2, p2)) return true;

    return false;
};

const CUBIC_STEPS = 24;

/**
 * Samples the polyline of an SVG `M x,y C c1x,c1y c2x,c2y x,y` path, the shape
 * xyflow's `getBezierPath` emits. Anything else yields no points, so such an
 * edge is never cut; the test pins the format so a change fails loudly there.
 */
export const sampleBezierPath = (d: string, steps: number = CUBIC_STEPS): Point[] => {
    const numbers = (d.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

    if (numbers.length !== 8) return [];

    const [x0, y0, x1, y1, x2, y2, x3, y3] = numbers as [number, number, number, number, number, number, number, number];

    return Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        const u = 1 - t;
        const a = u * u * u;
        const b = 3 * u * u * t;
        const c = 3 * u * t * t;
        const e = t * t * t;

        return { x: a * x0 + b * x1 + c * x2 + e * x3, y: a * y0 + b * y1 + c * y2 + e * y3 };
    });
};

/** Ids of the edges whose sampled polyline the cut segment crosses. */
export const edgesCrossedBy = (cut: readonly [Point, Point], edges: ReadonlyArray<{ id: string; points: Point[] }>): string[] =>
    edges.filter(({ points }) => points.some((p, i) => i > 0 && segmentsIntersect(points[i - 1]!, p, cut[0], cut[1]))).map(({ id }) => id);
