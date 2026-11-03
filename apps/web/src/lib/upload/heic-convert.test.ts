import { beforeEach, describe, expect, it, vi } from "vitest";

import { convertHeicToJpeg, isHeicFile, jpegNameFor } from "./heic-convert";

const { heicTo } = vi.hoisted(() => {
    return {
        heicTo: vi.fn(async () => new Blob(["jpeg bytes"], { type: "image/jpeg" })),
    };
});

vi.mock("heic-to", () => {
    return { heicTo };
});

describe("isHeicFile", () => {
    it("recognises HEIC and HEIF by declared type, and by name when the browser gives no type", () => {
        expect(isHeicFile({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
        expect(isHeicFile({ name: "scan.heif", type: "image/heif-sequence" })).toBe(true);
        expect(isHeicFile({ name: "IMG_0002.heic", type: "" })).toBe(true);
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
    });
});

describe("convertHeicToJpeg", () => {
    beforeEach(() => {
        heicTo.mockClear();
    });

    it("returns a file that is not HEIC unchanged, without loading the decoder", async () => {
        const photo = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

        await expect(convertHeicToJpeg(photo)).resolves.toBe(photo);
        expect(heicTo).not.toHaveBeenCalled();
    });

    it("re-encodes a HEIC file as a JPEG file under the same name", async () => {
        const photo = new File(["heic"], "IMG_0003.HEIC", { lastModified: 1234, type: "image/heic" });

        const converted = await convertHeicToJpeg(photo);

        expect(heicTo).toHaveBeenCalledWith(expect.objectContaining({ blob: photo, quality: 0.92, type: "image/jpeg" }));
        expect(converted.name).toBe("IMG_0003.jpg");
        expect(converted.type).toBe("image/jpeg");
        expect(converted.lastModified).toBe(1234);
    });

    it("rejects when the decoder cannot read the file", async () => {
        heicTo.mockRejectedValueOnce(new Error("not a HEIC image"));

        await expect(convertHeicToJpeg(new File(["x"], "broken.heic", { type: "image/heic" }))).rejects.toThrow("not a HEIC image");
    });
});
