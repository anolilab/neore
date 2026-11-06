import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { canConvertHeic, convertHeicToJpeg, decodesHeic, isHeicFile, jpegNameFor, willConvertHeic } from "./heic-convert";

const { heicToJpegBlob } = vi.hoisted(() => {
    return { heicToJpegBlob: vi.fn(async () => new Blob(["jpeg bytes"], { type: "image/jpeg" })) };
});

vi.mock("./heic-decode", () => {
    return { heicToJpegBlob };
});

const DESKTOP_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const IPHONE_SAFARI = `${IOS} Version/18.1 Mobile/15E148 Safari/604.1`;
const IPHONE_CHROME = `${IOS} CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1`;
const IPHONE_FIREFOX = `${IOS} FxiOS/132.0 Mobile/15E148 Safari/605.1.15`;
const IPHONE_EDGE = `${IOS} EdgiOS/131.0.2903.146 Mobile/15E148 Safari/604.1`;
const IPHONE_IN_APP = `${IOS} Mobile/15E148 [FBAN/FBIOS;FBDV/iPhone16,1;FBSV/18.1]`;
const IPAD_CHROME = "Mozilla/5.0 (iPad; CPU OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1";
const IPADOS_SAFARI_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";
const MAC_CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const WINDOWS_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";

/** The browser the converter reads: its user agent and how many touch points it has. */
const useBrowser = (userAgent: string | undefined, maxTouchPoints = 0): void => {
    vi.stubGlobal("navigator", { maxTouchPoints, userAgent });
};

const heicPhoto = (name = "IMG_0001.HEIC"): File => new File(["heic"], name, { type: "image/heic" });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe(isHeicFile, () => {
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

describe(jpegNameFor, () => {
    it("keeps the name and swaps the extension", () => {
        expect(jpegNameFor("IMG_0001.HEIC")).toBe("IMG_0001.jpg");
        expect(jpegNameFor("holiday.heif")).toBe("holiday.jpg");
        expect(jpegNameFor("photo.png")).toBe("photo.jpg");
    });
});

describe(decodesHeic, () => {
    it.each([
        ["desktop Safari", DESKTOP_SAFARI, 0, true],
        ["Safari on iPhone", IPHONE_SAFARI, 5, true],
        ["Chrome on iPhone", IPHONE_CHROME, 5, true],
        ["Firefox on iPhone", IPHONE_FIREFOX, 5, true],
        ["Edge on iPhone", IPHONE_EDGE, 5, true],
        ["an in-app browser on iPhone, which has no Safari token", IPHONE_IN_APP, 5, true],
        ["Chrome on iPad", IPAD_CHROME, 5, true],
        ["Safari on iPadOS in desktop mode, told apart by its touch screen", IPADOS_SAFARI_DESKTOP_MODE, 5, true],
        ["Chrome on a Mac, which has no HEIC decoder", MAC_CHROME, 0, false],
        ["Firefox on Windows", WINDOWS_FIREFOX, 0, false],
        ["Chrome on Android", ANDROID_CHROME, 5, false],
        ["no user agent at all", undefined, 0, false],
    ])("%s decodes HEIC: %s", (_label, userAgent, touchPoints, expected) => {
        expect(decodesHeic(userAgent, touchPoints)).toBe(expected);
    });

    it("reads the browser's own user agent and touch points", () => {
        useBrowser(IPHONE_CHROME, 5);
        expect(canConvertHeic()).toBe(true);

        useBrowser(MAC_CHROME, 0);
        expect(canConvertHeic()).toBe(false);
    });
});

describe(willConvertHeic, () => {
    it("converts a HEIC file in Safari, which decodes it", () => {
        useBrowser(DESKTOP_SAFARI);

        expect(willConvertHeic({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
    });

    it("converts a HEIC file in another browser on iOS, which decodes it through WebKit", () => {
        useBrowser(IPHONE_CHROME, 5);

        expect(willConvertHeic({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(true);
    });

    it("does not convert a HEIC file in a browser that cannot decode it", () => {
        useBrowser(MAC_CHROME);

        expect(willConvertHeic({ name: "IMG_0001.HEIC", type: "image/heic" })).toBe(false);
    });

    it("never converts a file that is not HEIC", () => {
        useBrowser(DESKTOP_SAFARI);

        expect(willConvertHeic({ name: "photo.jpg", type: "image/jpeg" })).toBe(false);
    });
});

describe(convertHeicToJpeg, () => {
    beforeEach(() => {
        heicToJpegBlob.mockClear();
    });

    it("returns a file that is not HEIC unchanged, without loading the decoder", async () => {
        useBrowser(DESKTOP_SAFARI);
        const photo = new File(["jpeg"], "photo.jpg", { type: "image/jpeg" });

        await expect(convertHeicToJpeg(photo)).resolves.toBe(photo);
        expect(heicToJpegBlob).not.toHaveBeenCalled();
    });

    it("re-encodes a HEIC file in Safari as a JPEG file under the same name", async () => {
        useBrowser(DESKTOP_SAFARI);
        const photo = new File(["heic"], "IMG_0003.HEIC", { lastModified: 1234, type: "image/heic" });

        const converted = await convertHeicToJpeg(photo);

        expect(heicToJpegBlob).toHaveBeenCalledWith(photo, 0.92);
        expect(converted.name).toBe("IMG_0003.jpg");
        expect(converted.type).toBe("image/jpeg");
        expect(converted.lastModified).toBe(1234);
    });

    it.each([
        ["Chrome on iPhone", IPHONE_CHROME, 5],
        ["Firefox on iPhone", IPHONE_FIREFOX, 5],
        ["an in-app browser on iPhone", IPHONE_IN_APP, 5],
        ["Chrome on iPad", IPAD_CHROME, 5],
    ])("re-encodes a HEIC file in %s, as it does in Safari", async (_label, userAgent, touchPoints) => {
        useBrowser(userAgent, touchPoints);
        const photo = heicPhoto("IMG_0005.HEIC");

        const converted = await convertHeicToJpeg(photo);

        expect(heicToJpegBlob).toHaveBeenCalledWith(photo, 0.92);
        expect(converted.name).toBe("IMG_0005.jpg");
    });

    it("keeps a HEIC file unchanged in a browser that cannot decode it, for the server to refuse", async () => {
        useBrowser(MAC_CHROME);
        const photo = heicPhoto("IMG_0004.HEIC");

        await expect(convertHeicToJpeg(photo)).resolves.toBe(photo);
        expect(heicToJpegBlob).not.toHaveBeenCalled();
    });

    it.each([
        ["desktop Safari", DESKTOP_SAFARI, 0],
        ["Chrome on iPhone", IPHONE_CHROME, 5],
        ["Chrome on a Mac", MAC_CHROME, 0],
    ])("decides the same in %s for the size precheck and the conversion", async (_label, userAgent, touchPoints) => {
        useBrowser(userAgent, touchPoints);
        const photo = heicPhoto();

        const converted = await convertHeicToJpeg(photo);

        expect(willConvertHeic(photo)).toBe(converted !== photo);
    });

    it("rejects when the decoder cannot read the file", async () => {
        useBrowser(DESKTOP_SAFARI);
        heicToJpegBlob.mockRejectedValueOnce(new Error("not a HEIC image"));

        await expect(convertHeicToJpeg(new File(["x"], "broken.heic", { type: "image/heic" }))).rejects.toThrow("not a HEIC image");
    });
});
