import { beforeEach, describe, expect, it, vi } from "vitest";

import { convertHeicToJpeg, isHeicFile, jpegNameFor, willConvertHeic } from "./heic-convert";

const { heicToJpegBlob, isSafariUserAgent } = vi.hoisted(() => {
    return {
        heicToJpegBlob: vi.fn(async () => new Blob(["jpeg bytes"], { type: "image/jpeg" })),
        isSafariUserAgent: vi.fn(() => true),
    };
});

vi.mock("./heic-decode", () => {
    return { heicToJpegBlob };
});

vi.mock("@/features/local-models/lib/local-errors", () => {
    return { isSafariUserAgent };
});

describe("isHeicFile", () => {
    it("recognises HEIC and HEIF by declared type, and by name when the browser gives no type", () => {
        expect(isHeicFile({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
        expect(isHeicFile({ name: "IMG_0002.heic", type: "" })).toBe(true);
    });

    it("trusts a declared type over the name, so a renamed text file is not a photo", () => {
        expect(isHeicFile({ name: "notes.heic", type: "text/plain" })).toBe(false);
    });

    it("leaves a multi-frame sequence alone, since one JPEG would keep only one of its frames", () => {
        expect(isHeicFile({ name: "burst.heic", type: "image/heic-sequence" })).toBe(false);
        expect(isHeicFile({ name: "scan.heif", type: "image/heif-sequence" })).toBe(false);
    });

    it("leaves every other file alone", () => {
        expect(isHeicFile({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
        expect(isHeicFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
        expect(isHeicFile({ name: "heic-notes.pdf", type: "application/pdf" })).toBe(false);
    });
});

describe("jpegNameFor", () => {
    it("keeps the name and swaps the extension", () => {
        expect(jpegNameFor("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
        expect(jpegNameFor("holiday.heif")).toBe("holiday.jpg");
        expect(jpegNameFor("photo.png")).toBe("photo.jpg");
    });
});

describe("willConvertHeic", () => {
    beforeEach(() => {
        isSafariUserAgent.mockReturnValue(true);
    });

    it("converts a HEIC file in Safari, which decodes it", () => {
        expect(willConvertHeic({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
    });

    it("does not convert a HEIC file in a browser that cannot decode it", () => {
        isSafariUserAgent.mockReturnValue(false);

        expect(willConvertHeic({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(false);
    });

    it("never converts a file that is not HEIC", () => {
        expect(willConvertHeic({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
    });
});

describe("convertHeicToJpeg", () => {
    beforeEach(() => {
        heicToJpegBlob.mockClear();
        isSafariUserAgent.mockReturnValue(true);
    });

    it("returns a file that is not HEIC unchanged, without loading the decoder", async () => {
        const photo = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

        await expect(convertHeicToJpeg(photo)).resolves.toBe(photo);
        expect(heicToJpegBlob).not.toHaveBeenCalled();
    });

    it("re-encodes a HEIC file in Safari as a JPEG file under the same name", async () => {
        const photo = new File(["heic"], "IMG_0003.HEIC", { lastModified: 1234, type: "image/heic" });

        const converted = await convertHeicToJpeg(photo);

        expect(heicToJpegBlob).toHaveBeenCalledWith(photo, 0.92);
        expect(converted.name).toBe("IMG_0003.jpg");
        expect(converted.type).toBe("image/jpeg");
        expect(converted.lastModified).toBe(1234);
    });

    it("keeps a HEIC file unchanged in a browser that cannot decode it, for the server to refuse", async () => {
        isSafariUserAgent.mockReturnValue(false);
        const photo = new File(["heic"], "IMG_0004.HEIC", { type: "image/heic" });

        await expect(convertHeicToJpeg(photo)).resolves.toBe(photo);
        expect(heicToJpegBlob).not.toHaveBeenCalled();
    });

    it("rejects when the decoder cannot read the file", async () => {
        heicToJpegBlob.mockRejectedValueOnce(new Error("not a HEIC image"));

        await expect(convertHeicToJpeg(new File(["x"], "broken.heic", { type: "image/heic" }))).rejects.toThrow("not a HEIC image");
    });
});
