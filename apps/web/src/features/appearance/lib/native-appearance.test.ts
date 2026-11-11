import { afterEach, describe, expect, it } from "vitest";

import { contrastRatio } from "./color-contrast";
import {
    applySystemAccentTokens,
    cacheSystemAccentTokens,
    effectiveAccent,
    effectiveMainFont,
    isAccentChoice,
    SYSTEM_ACCENT_CACHE_KEY,
    SYSTEM_ACCENT_PROPERTIES,
} from "./native-appearance";
import { systemAccentTokens } from "./system-accent-tokens";

/** The macOS accent palette (System Settings > Appearance), and two extremes. */
const MACOS_ACCENTS = [
    ["blue", "#007aff"],
    ["purple", "#953d96"],
    ["pink", "#f74f9e"],
    ["red", "#e0383e"],
    ["orange", "#f7821b"],
    ["yellow", "#ffc600"],
    ["green", "#62ba46"],
    ["graphite", "#8c8c8c"],
    ["white", "#ffffff"],
    ["black", "#000000"],
] as const;

/** The same bars as accent-presets.test.ts (4.5:1 text, 3:1 against the surfaces) and contrast-presets.test.ts (7:1). */
const AA_TEXT = 4.5;
const AAA_TEXT = 7;
const AA_NON_TEXT = 3;

/** `--background` / `--card` of packages/ui/src/global.css and of contrast-presets.css. */
const SURFACES = {
    contrastDark: ["#000000"],
    contrastLight: ["#ffffff"],
    dark: ["#212121"],
    light: ["#f2f2f2", "#ffffff"],
} as const;

const HEX = /^#[\da-f]{6}$/;

describe(systemAccentTokens, () => {
    describe.each(MACOS_ACCENTS)("%s (%s)", (_name, hex) => {
        const tokens = systemAccentTokens(hex);

        it("emits a #rrggbb value for every token", () => {
            expect(new Set(Object.keys(tokens))).toStrictEqual(new Set(Object.keys(SYSTEM_ACCENT_PROPERTIES)));

            const values = Object.values(tokens);

            for (const value of values) {
                expect(value).toMatch(HEX);
            }
        });

        it.each(["light", "dark"] as const)(`%s: label ≥ ${AA_TEXT}:1, accent ≥ ${AA_NON_TEXT}:1 against the background and card`, (mode) => {
            expect(contrastRatio(tokens[`${mode}Foreground`], tokens[mode])).toBeGreaterThanOrEqual(AA_TEXT);

            const surfaces = SURFACES[mode];

            for (const surface of surfaces) {
                expect(contrastRatio(tokens[mode], surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
            }
        });

        it.each(["contrastLight", "contrastDark"] as const)(`%s: label ≥ ${AAA_TEXT}:1, accent ≥ ${AA_NON_TEXT}:1 against the background`, (mode) => {
            expect(contrastRatio(tokens[`${mode}Foreground`], tokens[mode])).toBeGreaterThanOrEqual(AAA_TEXT);

            const surfaces = SURFACES[mode];

            for (const surface of surfaces) {
                expect(contrastRatio(tokens[mode], surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
            }
        });

        // `--primary-text` (links, accent-coloured words) is ordinary text: the fill's 3:1 is not enough for it.
        it.each([
            ["light", AA_TEXT],
            ["dark", AA_TEXT],
            ["contrastLight", AAA_TEXT],
            ["contrastDark", AAA_TEXT],
        ] as const)("%s: the text shade reads at %s:1 on the background and card", (mode, bar) => {
            const surfaces = SURFACES[mode];

            for (const surface of surfaces) {
                expect(contrastRatio(tokens[`${mode}Text`], surface)).toBeGreaterThanOrEqual(bar);
            }
        });

        it.each([
            ["light", AA_TEXT],
            ["dark", AA_TEXT],
            ["contrastLight", AAA_TEXT],
            ["contrastDark", AAA_TEXT],
        ] as const)("%s: the label keeps %s:1 on the hover shade, which differs from the fill", (mode, bar) => {
            expect(contrastRatio(tokens[`${mode}Foreground`], tokens[`${mode}Hover`])).toBeGreaterThanOrEqual(bar);

            if (tokens[mode] !== "#000000" && tokens[mode] !== "#ffffff") {
                expect(tokens[`${mode}Hover`]).not.toBe(tokens[mode]);
            }
        });
    });

    it("keeps an OS accent that already passes, and puts the better label on it", () => {
        // #007aff carries white at only 4.02:1, so light mode darkens it; dark mode lightens it under obsidian.
        const blue = systemAccentTokens("#007AFF");

        expect(blue.light).not.toBe("#007aff");
        expect(blue.lightForeground).toBe("#ffffff");
        expect(systemAccentTokens("#ffc600").darkForeground).toBe("#191919");
        expect(systemAccentTokens("#1d4ed8")).toMatchObject({ light: "#1d4ed8", lightForeground: "#ffffff" });
    });
});

describe("system accent tokens on <html>", () => {
    afterEach(() => {
        applySystemAccentTokens(null);
        localStorage.clear();
    });

    const blue = systemAccentTokens("#007aff");

    const properties = Object.entries(SYSTEM_ACCENT_PROPERTIES);

    it("sets and clears the custom properties", () => {
        applySystemAccentTokens(blue);

        for (const [key, property] of properties) {
            expect(document.documentElement.style.getPropertyValue(property)).toBe(blue[key as keyof typeof blue]);
        }

        applySystemAccentTokens(null);

        for (const [, property] of properties) {
            expect(document.documentElement.style.getPropertyValue(property)).toBe("");
        }
    });

    it("caches the tokens for the boot script and forgets them", () => {
        cacheSystemAccentTokens(blue);
        expect(JSON.parse(localStorage.getItem(SYSTEM_ACCENT_CACHE_KEY) ?? "null")).toStrictEqual(blue);

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
