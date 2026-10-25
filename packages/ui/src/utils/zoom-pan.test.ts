import { describe, expect, it } from "vitest";

import {
    arrowKeyPan,
    CENTRE,
    clampPan,
    clampZoom,
    doubleClickZoom,
    INITIAL_ZOOM_VIEW,
    MAX_ZOOM,
    MIN_ZOOM,
    panBy,
    wheelDeltaInPixels,
    wheelZoomFactor,
    zoomAround,
    zoomAt,
} from "./zoom-pan";

// A 200x100 image shown at 300x200 in a viewport: scale 2 covers 400x200,
// so horizontal pan is limited to 50px either side and vertical to 0.
const content = { height: 100, width: 200 };
const viewport = { height: 200, width: 300 };

describe("clampZoom", () => {
    it("keeps the scale within [MIN_ZOOM, MAX_ZOOM]", () => {
        expect(clampZoom(0.2)).toBe(MIN_ZOOM);
        expect(clampZoom(MAX_ZOOM + 10)).toBe(MAX_ZOOM);
        expect(clampZoom(2.5)).toBe(2.5);
    });

    it("treats NaN as the minimum and Infinity as the maximum", () => {
        expect(clampZoom(NaN)).toBe(MIN_ZOOM);
        expect(clampZoom(Infinity)).toBe(MAX_ZOOM);
    });
});

describe("wheelZoomFactor", () => {
    it("zooms in for a negative delta and out for a positive one", () => {
        expect(wheelZoomFactor(-100, false)).toBeGreaterThan(1);
        expect(wheelZoomFactor(100, false)).toBeLessThan(1);
        expect(wheelZoomFactor(0, false)).toBe(1);
    });

    it("is reversible: an in-delta followed by the equal out-delta returns to the start", () => {
        expect(wheelZoomFactor(-37, false) * wheelZoomFactor(37, false)).toBeCloseTo(1, 12);
        expect(wheelZoomFactor(-4, true) * wheelZoomFactor(4, true)).toBeCloseTo(1, 12);
    });

    it("reacts more to a mouse notch than to a pinch step, and more to a pinch than to a tiny delta", () => {
        const notch = Math.abs(Math.log(wheelZoomFactor(-100, false)));
        const pinchStep = Math.abs(Math.log(wheelZoomFactor(-3, true)));
        const mouseStep = Math.abs(Math.log(wheelZoomFactor(-3, false)));

        expect(notch).toBeGreaterThan(pinchStep);
        expect(pinchStep).toBeGreaterThan(mouseStep);
    });

    it("bounds one event so a single huge delta cannot jump the scale", () => {
        expect(wheelZoomFactor(-100_000, false)).toBe(wheelZoomFactor(-250, false));
    });
});

describe("wheelDeltaInPixels", () => {
    it("converts line deltas to pixels and leaves pixel deltas alone", () => {
        expect(wheelDeltaInPixels(3, 1)).toBe(48);
        expect(wheelDeltaInPixels(100, 0)).toBe(100);
    });
});

describe("clampPan", () => {
    it("returns the origin at scale 1, whatever offset it was given", () => {
        expect(clampPan({ scale: 1, x: 30, y: -20 }, content, viewport)).toEqual({ scale: 1, x: 0, y: 0 });
    });

    it("limits the offset to the part of the scaled image that overflows the viewport", () => {
        expect(clampPan({ scale: 2, x: 500, y: 0 }, content, viewport)).toEqual({ scale: 2, x: 50, y: 0 });
        expect(clampPan({ scale: 2, x: -500, y: 0 }, content, viewport)).toEqual({ scale: 2, x: -50, y: 0 });
    });

    it("pins the vertical offset to 0 when the scaled image does not overflow vertically", () => {
        expect(clampPan({ scale: 2, x: 0, y: 80 }, content, viewport).y).toBe(0);
    });

    it("leaves an offset inside the bounds unchanged", () => {
        expect(clampPan({ scale: 2, x: 12, y: 0 }, content, viewport)).toEqual({ scale: 2, x: 12, y: 0 });
    });
});

describe("zoomAt", () => {
    it("keeps the image point under the pointer fixed across the zoom", () => {
        const view = { scale: 2, x: 10, y: -5 };
        const pointer = { x: 30, y: 40 };
        const before = { x: (pointer.x - view.x) / view.scale, y: (pointer.y - view.y) / view.scale };

        const after = zoomAt(view, 4, pointer);
        const imagePointAfter = { x: (pointer.x - after.x) / after.scale, y: (pointer.y - after.y) / after.scale };

        expect(after.scale).toBe(4);
        expect(imagePointAfter.x).toBeCloseTo(before.x, 10);
        expect(imagePointAfter.y).toBeCloseTo(before.y, 10);
    });

    it("scales the offset about the centre when the pointer is at the centre", () => {
        const view = { scale: 1.5, x: 8, y: 6 };

        expect(zoomAt(view, 3, CENTRE)).toEqual({ scale: 3, x: 16, y: 12 });
    });

    it("clamps the requested scale before computing the offset", () => {
        expect(zoomAt(INITIAL_ZOOM_VIEW, 100, CENTRE).scale).toBe(MAX_ZOOM);
    });
});

describe("zoomAround", () => {
    it("zooms at the pointer and then clamps the offset to the bounds", () => {
        // Pointer at the right edge zooms towards it; the result must still stay inside the pan limit.
        const next = zoomAround(INITIAL_ZOOM_VIEW, 2, { x: 150, y: 0 }, content, viewport);

        expect(next.scale).toBe(2);
        expect(next.x).toBeGreaterThanOrEqual(-50);
        expect(next.x).toBeLessThanOrEqual(50);
    });

    it("returns to the origin when zooming back out to scale 1", () => {
        const zoomed = zoomAround(INITIAL_ZOOM_VIEW, 2, { x: 40, y: 10 }, content, viewport);

        expect(zoomAround(zoomed, 1, { x: 40, y: 10 }, content, viewport)).toEqual({ scale: 1, x: 0, y: 0 });
    });
});

describe("arrowKeyPan", () => {
    it("moves the view the way a scrolling page does: right reveals the right, so the image moves left", () => {
        expect(arrowKeyPan("ArrowRight")).toEqual({ x: -40, y: 0 });
        expect(arrowKeyPan("ArrowLeft")).toEqual({ x: 40, y: 0 });
        expect(arrowKeyPan("ArrowDown")).toEqual({ x: 0, y: -40 });
        expect(arrowKeyPan("ArrowUp")).toEqual({ x: 0, y: 40 });
    });

    it("returns null for keys that are not arrows", () => {
        expect(arrowKeyPan("a")).toBeNull();
        expect(arrowKeyPan("Escape")).toBeNull();
    });
});

describe("panBy", () => {
    it("moves the offset and clamps it", () => {
        const zoomed = { scale: 2, x: 0, y: 0 };

        expect(panBy(zoomed, 20, 0, content, viewport).x).toBe(20);
        expect(panBy(zoomed, 200, 0, content, viewport).x).toBe(50);
        expect(panBy(zoomed, -200, 0, content, viewport).x).toBe(-50);
    });

    it("does nothing at scale 1", () => {
        expect(panBy(INITIAL_ZOOM_VIEW, 40, 40, content, viewport)).toEqual({ scale: 1, x: 0, y: 0 });
    });
});

describe("doubleClickZoom", () => {
    it("zooms in on the pointer from scale 1", () => {
        const next = doubleClickZoom(INITIAL_ZOOM_VIEW, { x: 0, y: 0 }, content, viewport);

        expect(next.scale).toBe(2);
    });

    it("resets when already zoomed", () => {
        const zoomed = { scale: 3, x: 20, y: 0 };

        expect(doubleClickZoom(zoomed, { x: 10, y: 10 }, content, viewport)).toEqual(INITIAL_ZOOM_VIEW);
    });
});
