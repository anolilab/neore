import { describe, expect, it } from "vitest";

import { accentHex, DARK_BACKGROUND, LIGHT_BACKGROUND, supportsVibrancy, TRANSPARENT_BACKGROUND, windowBackground } from "./appearance.js";

describe(accentHex, () => {
    it.each([
        ["0a84ffff", "#0a84ff"],
        ["FF453AFF", "#ff453a"],
        ["#00aaff", "#00aaff"],
        [" 112233ff ", "#112233"],
    ])("turns %s into %s", (raw, hex) => {
        expect(accentHex(raw)).toBe(hex);
    });

    it.each([[""], ["fff"], ["0a84ffff00"], ["zzzzzzzz"], [false], [undefined]])("refuses %s", (raw) => {
        expect(accentHex(raw)).toBeNull();
    });
});

describe(windowBackground, () => {
    it("follows the theme, and is clear under vibrancy", () => {
        expect(windowBackground({ dark: true, vibrancy: false })).toBe(DARK_BACKGROUND);
        expect(windowBackground({ dark: false, vibrancy: false })).toBe(LIGHT_BACKGROUND);
        expect(windowBackground({ dark: true, vibrancy: true })).toBe(TRANSPARENT_BACKGROUND);
    });
});

describe(supportsVibrancy, () => {
    it("is macOS only", () => {
        expect(supportsVibrancy("darwin")).toBe(true);
        expect(supportsVibrancy("win32")).toBe(false);
        expect(supportsVibrancy("linux")).toBe(false);
    });
});
