import { MAX_REFERENCE_VIDEO_BYTES } from "@neore/backend/document-limits";
import { describe, expect, it } from "vitest";

import { canTrimVideo, clampTrimRange, exceedsReferenceVideoLimit, hasMp4Header, outputSizeFor, referenceVideoLength, videoBitrateFor } from "./video-trim";

describe("outputSizeFor", () => {
    it("brings a frame down to 1920 on its longest side, keeping the aspect ratio and even sides", () => {
        expect(outputSizeFor(3840, 2160)).toEqual({ height: 1080, width: 1920 });
        expect(outputSizeFor(2160, 3840)).toEqual({ height: 1920, width: 1080 });
        expect(outputSizeFor(1280, 720)).toBeUndefined();
    });
});

describe("clampTrimRange", () => {
    it("keeps the range inside the clip and leaves at least a tenth of a second between start and end", () => {
        expect(clampTrimRange({ end: 12, start: 3 }, 20)).toEqual({ end: 12, start: 3 });
        expect(clampTrimRange({ end: 30, start: -1 }, 20)).toEqual({ end: 20, start: 0 });
        expect(clampTrimRange({ end: 5, start: 5 }, 20)).toEqual({ end: 5, start: 4.9 });
    });
});

describe("referenceVideoLength", () => {
    it("accepts 2 to 15 seconds, inclusive", () => {
        expect(referenceVideoLength(1.9)).toBe("too-short");
        expect(referenceVideoLength(2)).toBe("ok");
        expect(referenceVideoLength(15)).toBe("ok");
        expect(referenceVideoLength(15.1)).toBe("too-long");
    });
});

describe("videoBitrateFor and exceedsReferenceVideoLimit", () => {
    it("spends the byte cap across the clip, and the output guard trips only past the cap", () => {
        // A 15 s clip at 50 MB is about 28 Mbit/s, so the 12 Mbit/s ceiling applies.
        expect(videoBitrateFor(15)).toBe(12_000_000);
        // A 10-minute clip has to fit 50 MB: the budget is well under 1 Mbit/s.
        expect(videoBitrateFor(600)).toBeLessThan(1_000_000);
        expect(exceedsReferenceVideoLimit(MAX_REFERENCE_VIDEO_BYTES)).toBe(false);
        expect(exceedsReferenceVideoLimit(MAX_REFERENCE_VIDEO_BYTES + 1)).toBe(true);
    });
});

describe("hasMp4Header", () => {
    it("recognises an ftyp box at offset 4 and nothing else", () => {
        const mp4 = new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]);

        expect(hasMp4Header(mp4)).toBe(true);
        expect(hasMp4Header(new Uint8Array([0, 0, 0, 0x20, 0x6d, 0x6f, 0x6f, 0x76]))).toBe(false);
        expect(hasMp4Header(new Uint8Array([0x66, 0x74, 0x79, 0x70]))).toBe(false);
    });
});

describe("canTrimVideo", () => {
    it("is false where WebCodecs is missing, which is how the trim control stays hidden", async () => {
        // jsdom has no WebCodecs; the check must answer false, not throw.
        expect(await canTrimVideo()).toBe(false);
    });
});
