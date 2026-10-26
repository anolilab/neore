import { describe, expect, it } from "vitest";

import {
    downscaleOversizedImage,
    firstAttempt,
    isOversizedImage,
    MAX_ATTEMPTS,
    MAX_IMAGE_EDGE,
    nextAttempt,
    pngHasAlpha,
    TARGET_IMAGE_BYTES,
    webpIsAnimatedOrTransparent,
} from "./image-downscale";

const MEGABYTE = 1024 * 1024;

/** A big-endian uint32. */
const uint32 = (value: number): number[] => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);

const zeros = (length: number): number[] => [...new Uint8Array(length)];

/** A PNG head: signature, an IHDR of `colorType`, then `chunks` (type, payload length). */
const pngHead = (colorType: number, chunks: [string, number][] = [["IDAT", 4]]): Uint8Array => {
    const bytes: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const chunk = (type: string, length: number, payload: number[] = []) => {
        const name = [...type].map((c) => c.codePointAt(0) ?? 0);

        bytes.push(...uint32(length), ...name, ...payload, ...zeros(length - payload.length), ...zeros(4));
    };

    // width, height, bit depth, colour type, compression, filter, interlace
    chunk("IHDR", 13, [0, 0, 0, 1, 0, 0, 0, 1, 8, colorType, 0, 0, 0]);

    for (const [type, length] of chunks) {
        chunk(type, length);
    }

    return new Uint8Array(bytes);
};

describe(isOversizedImage, () => {
    it("is true only for a re-encodable type over the target", () => {
        expect(isOversizedImage({ size: TARGET_IMAGE_BYTES + 1, type: "image/jpeg" })).toBe(true);
        expect(isOversizedImage({ size: TARGET_IMAGE_BYTES + 1, type: "image/png" })).toBe(true);
        expect(isOversizedImage({ size: TARGET_IMAGE_BYTES + 1, type: "image/webp" })).toBe(true);
        expect(isOversizedImage({ size: TARGET_IMAGE_BYTES, type: "image/jpeg" })).toBe(false);
    });

    it("leaves GIF, SVG, icons and non-images alone however large", () => {
        for (const type of ["image/gif", "image/svg+xml", "image/x-icon", "application/pdf", ""]) {
            expect(isOversizedImage({ size: 20 * MEGABYTE, type })).toBe(false);
        }
    });

    it("keeps the target under Bedrock's 5 MB once base64 adds a third", () => {
        expect((TARGET_IMAGE_BYTES * 4) / 3).toBeLessThan(5 * MEGABYTE);
    });
});

describe(firstAttempt, () => {
    it("clamps the long edge and keeps the aspect ratio", () => {
        expect(firstAttempt(4000, 3000)).toStrictEqual({ height: 1536, quality: 0.85, width: MAX_IMAGE_EDGE });
        expect(firstAttempt(3000, 4000)).toStrictEqual({ height: MAX_IMAGE_EDGE, quality: 0.85, width: 1536 });
    });

    it("never enlarges an image already within the edge", () => {
        expect(firstAttempt(1200, 800)).toStrictEqual({ height: 800, quality: 0.85, width: 1200 });
    });

    it("never answers a zero side", () => {
        expect(firstAttempt(20_000, 1).height).toBe(1);
    });
});

describe(nextAttempt, () => {
    const first = firstAttempt(4000, 3000);

    it("stops once the output fits", () => {
        expect(nextAttempt(first, TARGET_IMAGE_BYTES)).toBeUndefined();
        expect(nextAttempt(first, 1000)).toBeUndefined();
    });

    it("lowers quality first, keeping the dimensions", () => {
        expect(nextAttempt(first, TARGET_IMAGE_BYTES * 2)).toStrictEqual({ ...first, quality: 0.7 });
    });

    it("never goes below the minimum quality, then shrinks the dimensions with the overshoot", () => {
        const floor = { ...first, quality: 0.6 };
        const next = nextAttempt(floor, TARGET_IMAGE_BYTES * 4);

        expect(next?.quality).toBeCloseTo(0.6);
        // sqrt(1/4) * 0.92 = 0.46
        expect(next?.width).toBe(Math.floor(first.width * 0.46));
        expect(next?.height).toBe(Math.floor(first.height * 0.46));
    });

    it("reaches the target in a few attempts on a size that follows area", () => {
        // A model of JPEG: bytes proportional to pixels, scaled by quality.
        const bytesFor = ({ height, quality, width }: { height: number; quality: number; width: number }): number => width * height * quality * 3;

        let attempt = firstAttempt(8000, 6000);
        let size = bytesFor(attempt);
        let tries = 1;

        for (let next = nextAttempt(attempt, size); next; next = nextAttempt(attempt, size)) {
            attempt = next;
            size = bytesFor(attempt);
            tries += 1;
        }

        expect(size).toBeLessThanOrEqual(TARGET_IMAGE_BYTES);
        expect(tries).toBeLessThanOrEqual(MAX_ATTEMPTS);
    });
});

describe(pngHasAlpha, () => {
    it("is true for greyscale+alpha and RGBA", () => {
        expect(pngHasAlpha(pngHead(4))).toBe(true);
        expect(pngHasAlpha(pngHead(6))).toBe(true);
    });

    it("is false for RGB, greyscale and palette images with no tRNS chunk", () => {
        for (const colorType of [0, 2, 3]) {
            expect(
                pngHasAlpha(
                    pngHead(colorType, [
                        ["gAMA", 4],
                        ["IDAT", 8],
                    ]),
                ),
            ).toBe(false);
        }
    });

    it("is true when a tRNS chunk comes before the image data", () => {
        expect(
            pngHasAlpha(
                pngHead(3, [
                    ["PLTE", 6],
                    ["tRNS", 2],
                    ["IDAT", 8],
                ]),
            ),
        ).toBe(true);
    });

    it("is true when the head ends before the image data, and for bytes that are not a PNG", () => {
        expect(pngHasAlpha(pngHead(2, [["iCCP", 200]]))).toBe(true);
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...zeros(40)]);

        expect(pngHasAlpha(jpeg)).toBe(true);
        expect(pngHasAlpha(new Uint8Array(4))).toBe(true);
    });
});

/** A WebP head: RIFF header, then a first chunk of `type` whose payload starts with `payload`. */
const webpHead = (type: string, payload: number[]): Uint8Array =>
    new Uint8Array([
        ...[..."RIFF"].map((c) => c.codePointAt(0) ?? 0),
        ...zeros(4),
        ...[..."WEBP"].map((c) => c.codePointAt(0) ?? 0),
        ...[...type].map((c) => c.codePointAt(0) ?? 0),
        ...zeros(4),
        ...payload,
        ...zeros(8),
    ]);

describe(webpIsAnimatedOrTransparent, () => {
    it("is false for a lossy still", () => {
        const lossy = zeros(10);

        expect(webpIsAnimatedOrTransparent(webpHead("VP8 ", lossy))).toBe(false);
    });

    it("reads the animation and alpha flags of an extended file", () => {
        expect(webpIsAnimatedOrTransparent(webpHead("VP8X", [0x00, 0, 0, 0]))).toBe(false);
        expect(webpIsAnimatedOrTransparent(webpHead("VP8X", [0x02, 0, 0, 0]))).toBe(true);
        expect(webpIsAnimatedOrTransparent(webpHead("VP8X", [0x10, 0, 0, 0]))).toBe(true);
    });

    it("reads the alpha bit of a lossless file", () => {
        expect(webpIsAnimatedOrTransparent(webpHead("VP8L", [0x2f, 0, 0, 0, 0x00]))).toBe(false);
        expect(webpIsAnimatedOrTransparent(webpHead("VP8L", [0x2f, 0, 0, 0, 0x10]))).toBe(true);
    });

    it("is true for bytes that are not a WebP", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...zeros(40)]);

        expect(webpIsAnimatedOrTransparent(jpeg)).toBe(true);
        expect(webpIsAnimatedOrTransparent(new Uint8Array(4))).toBe(true);
    });
});

describe(downscaleOversizedImage, () => {
    it("answers the same file when it is within the target", async () => {
        const file = new File(["small"], "a.jpg", { type: "image/jpeg" });

        expect(await downscaleOversizedImage(file)).toBe(file);
    });

    it("answers the same file for a GIF over the target", async () => {
        const file = new File([new Uint8Array(TARGET_IMAGE_BYTES + 1)], "a.gif", { type: "image/gif" });

        expect(await downscaleOversizedImage(file)).toBe(file);
    });

    it("answers the same file where the browser cannot decode images (jsdom has no createImageBitmap)", async () => {
        const file = new File([new Uint8Array(TARGET_IMAGE_BYTES + 1)], "a.jpg", { type: "image/jpeg" });

        expect(await downscaleOversizedImage(file)).toBe(file);
    });
});
