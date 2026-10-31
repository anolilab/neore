import { describe, expect, it, vi } from "vitest";

import { isTrustedUrl } from "../trust.js";
import { createPermissionPolicy, isDictationAsset, microphoneAllowed, microphoneSettingsPath } from "./permissions.js";

const SITE = "https://app.example";
const DICTATION_PAGE = "file:///app/dist/dictation-window/dictation.html";
const dictationContents = { id: 7 };
const otherContents = { id: 8 };

const policy = createPermissionPolicy({
    isDictationWindow: (webContents, url) => webContents === dictationContents && url === DICTATION_PAGE,
    isSiteUrl: (url) => isTrustedUrl(new URL(SITE), url),
    sitePermissions: new Set(["clipboard-sanitized-write", "media", "notifications"]),
});

const requested = (webContents: unknown, permission: string, requestingUrl: string, mediaTypes?: string[]): boolean => {
    let answer: boolean | undefined;

    policy.request(webContents, permission, (isAllowed) => {
        answer = isAllowed;
    }, { mediaTypes, requestingUrl });

    return answer as boolean;
};

describe("the dictation window", () => {
    it("is granted the microphone, for audio only", () => {
        expect(requested(dictationContents, "media", DICTATION_PAGE, ["audio"])).toBe(true);
        expect(policy.check(dictationContents, "media", "file:///", { mediaType: "audio", requestingUrl: DICTATION_PAGE })).toBe(true);
    });

    it.each([["video"], ["audio", "video"], ["unknown"], []])("is refused media of kind %j", (...types) => {
        expect(requested(dictationContents, "media", DICTATION_PAGE, types)).toBe(false);
    });

    it("is refused a request that does not say it is audio, and a check that says it is not", () => {
        expect(requested(dictationContents, "media", DICTATION_PAGE)).toBe(false);
        expect(policy.check(dictationContents, "media", "file:///", { mediaType: "video", requestingUrl: DICTATION_PAGE })).toBe(false);
        expect(policy.check(dictationContents, "media", "file:///", { mediaType: "unknown", requestingUrl: DICTATION_PAGE })).toBe(false);
    });

    it("passes the check Chromium makes before the request, which names no kind", () => {
        expect(policy.check(dictationContents, "media", "file:///", { requestingUrl: DICTATION_PAGE })).toBe(true);
    });

    it.each(["notifications", "clipboard-sanitized-write", "geolocation", "openExternal", "display-capture", "fullscreen", "hid"])("is refused %s", (permission) => {
        expect(requested(dictationContents, permission, DICTATION_PAGE, ["audio"])).toBe(false);
        expect(policy.check(dictationContents, permission, "file:///", { requestingUrl: DICTATION_PAGE })).toBe(false);
    });

    it("is refused the microphone for a frame that is not its own page", () => {
        expect(requested(dictationContents, "media", "file:///app/dist/device-window/device.html", ["audio"])).toBe(false);
        expect(requested(dictationContents, "media", "https://evil.example/", ["audio"])).toBe(false);
    });
});

describe("every other window", () => {
    it.each([
        ["the Quick Composer", "file:///app/dist/quick-composer/index.html"],
        ["the device window", "file:///app/dist/device-window/device.html"],
        ["a page that claims the dictation page's URL", DICTATION_PAGE],
        ["a foreign origin", "https://example.org/"],
        ["an opaque origin", "null"],
    ])("is refused the microphone: %s", (_name, url) => {
        expect(requested(otherContents, "media", url, ["audio"])).toBe(false);
        expect(policy.check(otherContents, "media", url, { mediaType: "audio", requestingUrl: url })).toBe(false);
        expect(policy.check(null, "media", url, { mediaType: "audio", requestingUrl: url })).toBe(false);
    });

    it("is refused when the contents are unknown", () => {
        expect(requested(null, "media", DICTATION_PAGE, ["audio"])).toBe(false);
        expect(requested(undefined, "media", DICTATION_PAGE, ["audio"])).toBe(false);
    });
});

describe("the site", () => {
    it("keeps what it had on its own origin", () => {
        expect(requested(otherContents, "media", `${SITE}/chat`, ["audio", "video"])).toBe(true);
        expect(requested(otherContents, "notifications", `${SITE}/chat`)).toBe(true);
        expect(policy.check(otherContents, "media", SITE)).toBe(true);
    });

    it("gets nothing it was not given", () => {
        expect(requested(otherContents, "geolocation", `${SITE}/chat`)).toBe(false);
        expect(requested(otherContents, "media", "https://example.org/", ["audio"])).toBe(false);
    });
});

describe("isDictationAsset", () => {
    const folder = "file:///app/dist/dictation-window/";

    it("allows the window's own files", () => {
        expect(isDictationAsset(folder, `${folder}dictation.html`)).toBe(true);
        expect(isDictationAsset(folder, `${folder}dictation.js`)).toBe(true);
    });

    it.each([
        "https://example.org/",
        "http://127.0.0.1:4399/",
        "ws://localhost:8788/socket",
        "file:///etc/passwd",
        "file:///app/dist/device-window/device.html",
        "file:///app/dist/dictation-window/../main.cjs",
        "data:text/html,hi",
        "blob:file:///x",
        "not a url",
    ])("refuses %s", (url) => {
        expect(isDictationAsset(folder, url)).toBe(false);
    });
});

describe("microphoneAllowed", () => {
    const access = (platform: NodeJS.Platform, status: string, answer = true) => {
        const ask = vi.fn(async () => answer);

        return { access: { ask, platform, status: () => status }, ask };
    };

    it.each([
        ["granted", true],
        ["denied", false],
        ["restricted", false],
    ] as const)("on macOS answers from the status without asking: %s", async (status, expected) => {
        const { access: given, ask } = access("darwin", status);

        expect(await microphoneAllowed(given)).toBe(expected);
        expect(ask).not.toHaveBeenCalled();
    });

    it.each([
        [true, "prompted"],
        [false, false],
    ] as const)("on macOS asks once when it has not been decided, and believes the answer (%s)", async (answer, expected) => {
        const { access: given, ask } = access("darwin", "not-determined", answer);

        expect(await microphoneAllowed(given)).toBe(expected);
        expect(ask).toHaveBeenCalledOnce();
    });

    it.each([
        ["granted", true],
        ["not-determined", true],
        ["unknown", true],
        ["denied", false],
        ["restricted", false],
    ] as const)("on Windows refuses only an explicit refusal, and never shows a prompt of its own: %s", async (status, expected) => {
        const { access: given, ask } = access("win32", status);

        expect(await microphoneAllowed(given)).toBe(expected);
        expect(ask).not.toHaveBeenCalled();
    });

    it("on Linux has no OS gate, and does not read a status the platform does not have", async () => {
        const ask = vi.fn(async () => false);
        const status = vi.fn(() => "denied");

        expect(await microphoneAllowed({ ask, platform: "linux", status })).toBe(true);
        expect(ask).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
    });

    it("names the settings page of each OS", () => {
        expect(microphoneSettingsPath("darwin")).toContain("System Settings");
        expect(microphoneSettingsPath("win32")).toContain("Privacy & security");
        expect(microphoneSettingsPath("linux")).toContain("sound");
    });
});
