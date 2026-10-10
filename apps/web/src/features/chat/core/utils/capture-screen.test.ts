import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { captureScreenFrame, isScreenCaptureSupported, screenshotFileName } from "./capture-screen";

const SCREENSHOT_NAME = /^screenshot-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/u;

const stopSpies: ReturnType<typeof vi.fn>[] = [];

const fakeStream = (): MediaStream => {
    const stop = vi.fn();

    stopSpies.push(stop);

    return { getTracks: () => [{ stop }] } as unknown as MediaStream;
};

const setDisplayMedia = (implementation: (() => Promise<MediaStream>) | undefined): void => {
    Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: implementation ? { getDisplayMedia: vi.fn(implementation) } : {},
    });
};

describe("capture-screen", () => {
    beforeEach(() => {
        stopSpies.length = 0;

        // jsdom has no media pipeline and no canvas: a video that "plays" with a
        // frame ready, and a 2D context whose PNG encoder yields a fixed blob.
        vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
        vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
        Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
        Object.defineProperties(HTMLVideoElement.prototype, {
            videoWidth: { configurable: true, get: () => 64 },
            videoHeight: { configurable: true, get: () => 32 },
        });
        vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as never);
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"], { type: "image/png" })));
    });

    afterEach(() => {
        vi.restoreAllMocks();
        Reflect.deleteProperty(HTMLMediaElement.prototype, "readyState");
        Reflect.deleteProperty(HTMLVideoElement.prototype, "videoWidth");
        Reflect.deleteProperty(HTMLVideoElement.prototype, "videoHeight");
    });

    it("is unsupported where getDisplayMedia is missing", () => {
        setDisplayMedia(undefined);

        expect(isScreenCaptureSupported()).toBe(false);
    });

    it("returns one PNG frame and stops the stream right away", async () => {
        setDisplayMedia(async () => fakeStream());

        expect(isScreenCaptureSupported()).toBe(true);

        const file = await captureScreenFrame();

        expect(file).toBeInstanceOf(File);
        expect(file?.type).toBe("image/png");
        expect(file?.name).toMatch(SCREENSHOT_NAME);
        expect(stopSpies[0]).toHaveBeenCalledTimes(1);
    });

    it("treats a dismissed picker as a cancellation, not an error", async () => {
        setDisplayMedia(async () => {
            throw new DOMException("denied", "NotAllowedError");
        });

        await expect(captureScreenFrame()).resolves.toBeNull();
    });

    it("stops the stream even when encoding fails", async () => {
        setDisplayMedia(async () => fakeStream());
        vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));

        await expect(captureScreenFrame()).rejects.toThrow("Could not encode the screenshot");
        expect(stopSpies[0]).toHaveBeenCalledTimes(1);
    });

    it("names files by local time", () => {
        expect(screenshotFileName(new Date(2026, 8, 5, 7, 3, 9))).toBe("screenshot-2026-09-05-07-03-09.png");
    });
});
