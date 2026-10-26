import { describe, expect, it } from "vitest";

import { detectPlatform } from "./detect-platform";

describe("detectPlatform", () => {
    it.each([
        ["Mac desktop Safari", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15"],
        ["Mac Chrome", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"],
    ])("%s -> macos without arch", (_name, ua) => {
        expect(detectPlatform(ua)).toEqual({ platform: "macos" });
    });

    it.each([
        ["Windows x64 Chrome", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"],
        ["Windows Edge", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Edg/120.0"],
    ])("%s -> windows without arch", (_name, ua) => {
        expect(detectPlatform(ua)).toEqual({ platform: "windows" });
    });

    it("Linux x86_64 -> linux x64", () => {
        expect(detectPlatform("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toEqual({
            arch: "x64",
            platform: "linux",
        });
    });

    it("Linux aarch64 -> linux arm64", () => {
        expect(detectPlatform("Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")).toEqual({
            arch: "arm64",
            platform: "linux",
        });
    });

    it("Linux with no arch token -> linux without arch", () => {
        expect(detectPlatform("Mozilla/5.0 (X11; Ubuntu; Linux; rv:120.0) Gecko/20100101 Firefox/120.0")).toEqual({ platform: "linux" });
    });

    it.each([
        ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
        ["iPad", "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"],
        ["Android", "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36"],
    ])("%s -> other, not macOS or Linux", (_name, ua) => {
        expect(detectPlatform(ua)).toEqual({ platform: "other" });
    });

    it("iPadOS in desktop mode (a Mac UA with touch points) -> other; a real Mac stays macos", () => {
        const desktopModeIpad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

        expect(detectPlatform(desktopModeIpad, 5)).toStrictEqual({ platform: "other" });
        expect(detectPlatform(desktopModeIpad, 0)).toStrictEqual({ platform: "macos" });
    });

    it("empty or unknown UA -> other", () => {
        expect(detectPlatform("")).toEqual({ platform: "other" });
        expect(detectPlatform("curl/8.4.0")).toEqual({ platform: "other" });
    });
});
