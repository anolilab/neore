import { describe, expect, it } from "vitest";

import { pickedFrameTime } from "./video-frame";

describe("pickedFrameTime", () => {
    it("takes the requested time, clamped into the clip and off its final sample", () => {
        expect(pickedFrameTime(5, 2.5)).toBe(2.5);
        expect(pickedFrameTime(5, 9)).toBeCloseTo(5 - 1 / 24);
        expect(pickedFrameTime(5, -1)).toBe(0);
    });
});
