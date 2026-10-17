import { describe, expect, it } from "vitest";

import { frameTimeFor } from "./video-frame";

describe("frameTimeFor", () => {
    it("takes the start at 0, the end one frame before the duration, and the picked time clamped into the clip", () => {
        expect(frameTimeFor("start", 5)).toBe(0);
        expect(frameTimeFor("end", 5)).toBeCloseTo(5 - 1 / 24);
        expect(frameTimeFor("picked", 5, 2.5)).toBe(2.5);
        expect(frameTimeFor("picked", 5, 9)).toBeCloseTo(5 - 1 / 24);
        expect(frameTimeFor("picked", 5, -1)).toBe(0);
    });
});
