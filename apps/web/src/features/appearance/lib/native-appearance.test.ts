import { afterEach, describe, expect, it } from "vitest";

import {
    applySystemAccentTokens,
    cacheSystemAccentTokens,
    effectiveAccent,
    effectiveMainFont,
    isAccentChoice,
    SYSTEM_ACCENT_CACHE_KEY,
    SYSTEM_ACCENT_FOREGROUND_PROPERTY,
    SYSTEM_ACCENT_PROPERTY,
    systemAccentTokens,
} from "./native-appearance";

describe(systemAccentTokens, () => {
    it("puts white text on a dark accent and obsidian on a light one", () => {
        expect(systemAccentTokens("#007AFF")).toStrictEqual({ accent: "#007aff", foreground: "#ffffff" });
        expect(systemAccentTokens("#ffc600")).toStrictEqual({ accent: "#ffc600", foreground: "#191919" });
    });
});

describe("system accent tokens on <html>", () => {
    afterEach(() => {
        applySystemAccentTokens(null);
        localStorage.clear();
    });

    it("sets and clears the custom properties", () => {
        applySystemAccentTokens({ accent: "#007aff", foreground: "#ffffff" });

        expect(document.documentElement.style.getPropertyValue(SYSTEM_ACCENT_PROPERTY)).toBe("#007aff");
        expect(document.documentElement.style.getPropertyValue(SYSTEM_ACCENT_FOREGROUND_PROPERTY)).toBe("#ffffff");

        applySystemAccentTokens(null);

        expect(document.documentElement.style.getPropertyValue(SYSTEM_ACCENT_PROPERTY)).toBe("");
    });

    it("caches the tokens for the boot script and forgets them", () => {
        cacheSystemAccentTokens({ accent: "#007aff", foreground: "#ffffff" });
        expect(JSON.parse(localStorage.getItem(SYSTEM_ACCENT_CACHE_KEY) ?? "null")).toStrictEqual({ accent: "#007aff", foreground: "#ffffff" });

        cacheSystemAccentTokens(null);
        expect(localStorage.getItem(SYSTEM_ACCENT_CACHE_KEY)).toBeNull();
    });
});

describe(effectiveAccent, () => {
    it("falls back to the default preset for a stored `system` where the OS accent is not offered", () => {
        expect(effectiveAccent("system", true, false)).toBe("default");
        expect(effectiveAccent("system", true, true)).toBe("system");
    });

    it("uses the OS accent for an untouched default only where it is offered", () => {
        expect(effectiveAccent("default", false, true)).toBe("system");
        expect(effectiveAccent(undefined, false, true)).toBe("system");
        expect(effectiveAccent("default", false, false)).toBe("default");
    });

    it("keeps an explicit default and any non-default preset", () => {
        expect(effectiveAccent("default", true, true)).toBe("default");
        expect(effectiveAccent("blue", false, true)).toBe("blue");
        expect(effectiveAccent("not-a-preset", true, false)).toBe("default");
    });

    it("recognises the choices", () => {
        expect(isAccentChoice("system")).toBe(true);
        expect(isAccentChoice("teal")).toBe(true);
        expect(isAccentChoice("magenta")).toBe(false);
    });
});

describe(effectiveMainFont, () => {
    it("uses the system face for an untouched default in the shell only", () => {
        expect(effectiveMainFont("inter", false, true)).toBe("system");
        expect(effectiveMainFont(undefined, false, true)).toBe("system");
        expect(effectiveMainFont("inter", false, false)).toBe("inter");
    });

    it("lets an explicit choice win, including an explicit default", () => {
        expect(effectiveMainFont("inter", true, true)).toBe("inter");
        expect(effectiveMainFont("serif", false, true)).toBe("serif");
        expect(effectiveMainFont("roboto-slab", false, false)).toBe("inter");
    });
});
