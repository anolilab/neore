import { describe, expect, it } from "vitest";

import { bytesToBase64, downsample, floatTo16BitPcm, joinTranscript } from "./pcm";

describe(downsample, () => {
    it("returns the input unchanged at the target rate", () => {
        const input = new Float32Array([0.1, 0.2]);

        expect(downsample(input, 16_000)).toBe(input);
    });

    it("averages each window when reducing the rate", () => {
        const output = downsample(new Float32Array([0, 1, 1, 1, 0.5, 0.5]), 48_000, 16_000);

        expect([...output].map((v) => Number(v.toFixed(3)))).toStrictEqual([0.667, 0.667]);
    });

    it("refuses to upsample", () => {
        expect(() => downsample(new Float32Array(4), 8000, 16_000)).toThrow(RangeError);
    });
});

describe(floatTo16BitPcm, () => {
    it("encodes little-endian int16 and clamps out-of-range samples", () => {
        const bytes = floatTo16BitPcm(new Float32Array([0, 1, -1, 2]));
        const view = new DataView(bytes.buffer);

        expect(bytes).toHaveLength(8);
        expect(view.getInt16(0, true)).toBe(0);
        expect(view.getInt16(2, true)).toBe(32_767);
        expect(view.getInt16(4, true)).toBe(-32_768);
        expect(view.getInt16(6, true)).toBe(32_767);
    });
});

describe(bytesToBase64, () => {
    it("matches the platform encoder", () => {
        const bytes = new Uint8Array([0, 1, 2, 250, 255]);

        expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    });
});

describe(joinTranscript, () => {
    it("joins with single spaces and keeps the base verbatim", () => {
        expect(joinTranscript("", " hello ", "world")).toBe("hello world");
        expect(joinTranscript("line one\n", "dictated")).toBe("line one\ndictated");
        expect(joinTranscript("draft", "", "  more")).toBe("draft more");
    });
});
