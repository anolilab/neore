import { afterEach, describe, expect, it, vi } from "vitest";

import {
    bmpHasAlpha,
    downscaleOversizedImage,
    firstAttempt,
    isOversizedImage,
    MAX_ATTEMPTS,
    MAX_IMAGE_EDGE,
    nextAttempt,
    pngHasAlpha,
    readImageSize,
    TARGET_IMAGE_BYTES,
    webpIsAnimatedOrTransparent,
} from "./image-downscale";

const MEGABYTE = 1024 * 1024;

/** A big-endian uint32. */
const uint32 = (value: number): number[] => [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256);

const zeros = (length: number): number[] => [...new Uint8Array(length)];

/** A PNG head: signature, an IHDR of `colorType`, then `chunks` (type, payload length). */
const pngHead = (colorType: number, chunks: [string, number][] = [["IDAT", 4]]): Uint8Array<ArrayBuffer> => {
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

/** An opaque PNG whose `iCCP` chunk (a colour profile) is `profileBytes` long, so it ends far past any fixed head read. */
const pngWithProfile = (profileBytes: number): Blob =>
    new Blob([
        pngHead(2, []),
        new Uint8Array([...uint32(profileBytes), ...[..."iCCP"].map((c) => c.codePointAt(0) ?? 0)]),
        new Uint8Array(profileBytes + 4),
        pngHead(2, [["IDAT", 8]]).subarray(33),
    ]);

/** `pngHead`, declaring a `width` × `height` image. */
const pngOfSize = (width: number, height: number): Uint8Array<ArrayBuffer> => {
    const head = pngHead(2);

    new DataView(head.buffer).setUint32(16, width);
    new DataView(head.buffer).setUint32(20, height);

    return head;
};

/** A JPEG head: SOI, an APP1 segment with `appBytes` of payload, then SOF0 declaring `width` × `height`. */
const jpegHead = (width: number, height: number, appBytes = 20, orientation?: number): Uint8Array<ArrayBuffer> => {
    const sof = appBytes + 6;
    const bytes = new Uint8Array(sof + 19);
    const view = new DataView(bytes.buffer);

    bytes.set([0xff, 0xd8, 0xff, 0xe1]);
    view.setUint16(4, appBytes + 2);

    if (orientation !== undefined) {
        // "Exif\0\0", a big-endian TIFF header, then an IFD0 of one entry: the orientation tag (type SHORT, count 1).
        bytes.set([0x45, 0x78, 0x69, 0x66, 0, 0, 0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8], 6);
        view.setUint16(20, 1);
        view.setUint16(22, 0x01_12);
        view.setUint16(24, 3);
        view.setUint32(26, 1);
        view.setUint16(30, orientation);
    }

    bytes.set([0xff, 0xc0], sof);
    view.setUint16(sof + 2, 17);
    bytes[sof + 4] = 8;
    view.setUint16(sof + 5, height);
    view.setUint16(sof + 7, width);

    return bytes;
};

const pngHasAlphaOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<boolean> => await pngHasAlpha(new Blob([bytes]));

describe(pngHasAlpha, () => {
    it("is true for greyscale+alpha and RGBA", async () => {
        expect(await pngHasAlphaOf(pngHead(4))).toBe(true);
        expect(await pngHasAlphaOf(pngHead(6))).toBe(true);
    });

    it("is false for RGB, greyscale and palette images with no tRNS chunk", async () => {
        for (const colorType of [0, 2, 3]) {
            expect(
                await pngHasAlphaOf(
                    pngHead(colorType, [
                        ["gAMA", 4],
                        ["IDAT", 8],
                    ]),
                ),
            ).toBe(false);
        }
    });

    it("is true when a tRNS chunk comes before the image data", async () => {
        expect(
            await pngHasAlphaOf(
                pngHead(3, [
                    ["PLTE", 6],
                    ["tRNS", 2],
                    ["IDAT", 8],
                ]),
            ),
        ).toBe(true);
    });

    it("is true for an animated PNG, whose acTL chunk comes before the image data", async () => {
        expect(
            await pngHasAlphaOf(
                pngHead(2, [
                    ["acTL", 8],
                    ["IDAT", 8],
                ]),
            ),
        ).toBe(true);
    });

    it("is false for an opaque PNG whose large pre-IDAT chunk runs past 256 KiB", async () => {
        expect(await pngHasAlpha(pngWithProfile(600 * 1024))).toBe(false);
    });

    it("is true when a tRNS chunk follows a large chunk", async () => {
        const blob = new Blob([pngWithProfile(600 * 1024).slice(0, -20), pngHead(3, [["tRNS", 2]]).subarray(33)]);

        expect(await pngHasAlpha(blob)).toBe(true);
    });

    it("is true when the head ends before the image data, and for bytes that are not a PNG", async () => {
        expect(await pngHasAlphaOf(pngHead(2, [["iCCP", 200]]))).toBe(true);
        const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...zeros(40)]);

        expect(await pngHasAlphaOf(jpeg)).toBe(true);
        expect(await pngHasAlphaOf(new Uint8Array(4))).toBe(true);
    });
});

/** A BMP head: "BM", the file header, then a DIB header whose bits-per-pixel field sits at byte 28. */
const bmpHead = (bitsPerPixel: number): Uint8Array<ArrayBuffer> => {
    const head = new Uint8Array(54);

    head.set([0x42, 0x4d]);
    new DataView(head.buffer).setInt32(18, 4000, true);
    new DataView(head.buffer).setInt32(22, 3000, true);
    new DataView(head.buffer).setUint16(28, bitsPerPixel, true);

    return head;
};

describe(bmpHasAlpha, () => {
    it("is true only for 32 bits per pixel", () => {
        expect(bmpHasAlpha(bmpHead(32))).toBe(true);
        expect(bmpHasAlpha(bmpHead(24))).toBe(false);
        expect(bmpHasAlpha(bmpHead(8))).toBe(false);
    });

    it("is true for bytes that are not a BMP", () => {
        const jpeg = new Uint8Array([0xff, 0xd8, ...zeros(40)]);

        expect(bmpHasAlpha(jpeg)).toBe(true);
        expect(bmpHasAlpha(new Uint8Array(4))).toBe(true);
    });
});

/** A WebP head: RIFF header, then a first chunk of `type` whose payload starts with `payload`. */
const webpHead = (type: string, payload: number[]): Uint8Array<ArrayBuffer> =>
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

const sizeOf = async (parts: BlobPart[], type: string) => await readImageSize(new File(parts, "a", { type }));

describe(readImageSize, () => {
    it("reads a PNG's IHDR", async () => {
        expect(await sizeOf([pngOfSize(640, 480)], "image/png")).toStrictEqual({ height: 480, width: 640 });
    });

    it("finds a JPEG's frame header past a large APP segment", async () => {
        expect(await sizeOf([jpegHead(5000, 3000, 40_000)], "image/jpeg")).toStrictEqual({ height: 3000, width: 5000 });
    });

    it("reads a JPEG's EXIF orientation, and leaves it out when there is no EXIF block", async () => {
        expect(await sizeOf([jpegHead(4000, 3000, 60, 6)], "image/jpeg")).toStrictEqual({ height: 3000, orientation: 6, width: 4000 });
        expect(await sizeOf([jpegHead(4000, 3000, 60)], "image/jpeg")).toStrictEqual({ height: 3000, width: 4000 });
    });

    it("reads a BMP and an extended WebP", async () => {
        expect(await sizeOf([bmpHead(24)], "image/bmp")).toStrictEqual({ height: 3000, width: 4000 });

        // 24-bit little-endian canvas width - 1 and height - 1 follow the 4 flag bytes.
        expect(await sizeOf([webpHead("VP8X", [0, 0, 0, 0, 0x0f, 0x01, 0, 0xc7, 0, 0])], "image/webp")).toStrictEqual({ height: 200, width: 272 });
    });

    it("answers undefined for bytes it cannot read", async () => {
        expect(await sizeOf([new Uint8Array(40)], "image/jpeg")).toBeUndefined();
        expect(await sizeOf([new Uint8Array(40)], "image/png")).toBeUndefined();
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

    describe("with a stubbed decoder and canvas", () => {
        afterEach(() => {
            vi.unstubAllGlobals();
            vi.restoreAllMocks();
        });

        /** A decoder for a 4000 × 3000 photo; every canvas encodes to `jpegBytes(quality)` bytes. */
        const stubBrowser = (jpegBytes: (width: number) => number) => {
            const create = vi.fn(async () => {
                return { close: vi.fn(), height: 3000, width: 4000 };
            });

            vi.stubGlobal("createImageBitmap", create);
            vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
                drawImage: vi.fn(),
                fillRect: vi.fn(),
            } as unknown as CanvasRenderingContext2D);
            vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function toBlob(this: HTMLCanvasElement, callback) {
                // eslint-disable-next-line unicorn/no-this-outside-of-class, unicorn/max-nested-calls -- the spied method is called on its canvas
                callback(new Blob([new Uint8Array(jpegBytes(this.width))], { type: "image/jpeg" }));
            });

            return create;
        };

        it("re-encodes an oversized opaque photo as a JPEG under the target", async () => {
            stubBrowser(() => TARGET_IMAGE_BYTES - 1);

            const file = new File([pngHead(2), new Uint8Array(TARGET_IMAGE_BYTES * 3)], "photo.png", { type: "image/png" });
            const result = await downscaleOversizedImage(file);

            expect(result.type).toBe("image/jpeg");
            expect(result.name).toBe("photo.jpg");
            expect(result.size).toBeLessThanOrEqual(TARGET_IMAGE_BYTES);
        });

        it("keeps shrinking past the first quality steps until the result fits", async () => {
            // Size follows the width: too big at 2048 px, so the quality steps and one shrink are not enough.
            stubBrowser((width) => width * 3000);

            const file = new File([jpegHead(4000, 3000), new Uint8Array(TARGET_IMAGE_BYTES * 8)], "photo.jpg", { type: "image/jpeg" });
            const result = await downscaleOversizedImage(file);

            expect(result.size).toBeLessThanOrEqual(TARGET_IMAGE_BYTES);
        });

        it("declines a 20000 × 20000 image without decoding it", async () => {
            const create = stubBrowser(() => 10);
            const file = new File([pngOfSize(20_000, 20_000), new Uint8Array(TARGET_IMAGE_BYTES + 1)], "huge.png", { type: "image/png" });

            expect(await downscaleOversizedImage(file)).toBe(file);
            expect(create).not.toHaveBeenCalled();
        });

        it("keeps an image whose header cannot be read, without decoding it", async () => {
            const create = stubBrowser(() => 10);
            const file = new File([new Uint8Array(TARGET_IMAGE_BYTES + 1)], "odd.jpg", { type: "image/jpeg" });

            expect(await downscaleOversizedImage(file)).toBe(file);
            expect(create).not.toHaveBeenCalled();
        });

        it("asks the decoder for the target size, so no full-size bitmap is allocated", async () => {
            const create = stubBrowser(() => TARGET_IMAGE_BYTES - 1);
            const file = new File([jpegHead(4000, 3000), new Uint8Array(TARGET_IMAGE_BYTES * 2)], "photo.jpg", { type: "image/jpeg" });

            await downscaleOversizedImage(file);

            expect(create).toHaveBeenCalledWith(file, { imageOrientation: "from-image", resizeHeight: 1536, resizeQuality: "high", resizeWidth: 2048 });
        });

        it("decodes a sideways photo (EXIF orientation 6) whole, without the resize options", async () => {
            const create = stubBrowser(() => TARGET_IMAGE_BYTES - 1);
            const file = new File([jpegHead(4000, 3000, 60, 6), new Uint8Array(TARGET_IMAGE_BYTES * 2)], "portrait.jpg", { type: "image/jpeg" });

            await downscaleOversizedImage(file);

            expect(create).toHaveBeenCalledExactlyOnceWith(file, { imageOrientation: "from-image" });
        });

        it("keeps the resize options for an upright photo (EXIF orientation 1)", async () => {
            const create = stubBrowser(() => TARGET_IMAGE_BYTES - 1);
            const file = new File([jpegHead(4000, 3000, 60, 1), new Uint8Array(TARGET_IMAGE_BYTES * 2)], "upright.jpg", { type: "image/jpeg" });

            await downscaleOversizedImage(file);

            expect(create).toHaveBeenCalledWith(file, expect.objectContaining({ resizeWidth: 2048 }));
        });

        it("decodes whole when the browser refuses the resize options", async () => {
            const create = stubBrowser(() => TARGET_IMAGE_BYTES - 1);

            create.mockRejectedValueOnce(new Error("unsupported"));

            const file = new File([jpegHead(4000, 3000), new Uint8Array(TARGET_IMAGE_BYTES * 2)], "photo.jpg", { type: "image/jpeg" });
            const result = await downscaleOversizedImage(file);

            expect(create).toHaveBeenLastCalledWith(file, { imageOrientation: "from-image" });
            expect(result.name).toBe("photo.jpg");
        });

        it("leaves a 32-bit BMP alone, because a JPEG would flatten its alpha", async () => {
            const create = stubBrowser(() => 10);
            const head = bmpHead(32);
            const file = new File([head, new Uint8Array(TARGET_IMAGE_BYTES + 1)], "a.bmp", { type: "image/bmp" });

            expect(await downscaleOversizedImage(file)).toBe(file);
            expect(create).not.toHaveBeenCalled();
        });

        it("re-encodes a 24-bit BMP", async () => {
            stubBrowser(() => 10);
            const file = new File([bmpHead(24), new Uint8Array(TARGET_IMAGE_BYTES + 1)], "a.bmp", { type: "image/bmp" });

            const result = await downscaleOversizedImage(file);

            expect(result.name).toBe("a.jpg");
        });

        it("re-encodes an opaque PNG with a colour profile over 256 KiB", async () => {
            stubBrowser(() => TARGET_IMAGE_BYTES - 1);

            const file = new File([pngWithProfile(600 * 1024), new Uint8Array(TARGET_IMAGE_BYTES)], "big.png", { type: "image/png" });

            const result = await downscaleOversizedImage(file);

            expect(result.type).toBe("image/jpeg");
        });

        it("leaves an opaque animated PNG alone", async () => {
            const create = stubBrowser(() => 10);
            const file = new File(
                [
                    pngHead(2, [
                        ["acTL", 8],
                        ["IDAT", 8],
                    ]),
                    new Uint8Array(TARGET_IMAGE_BYTES + 1),
                ],
                "a.png",
                { type: "image/png" },
            );

            expect(await downscaleOversizedImage(file)).toBe(file);
            expect(create).not.toHaveBeenCalled();
        });
    });
});
