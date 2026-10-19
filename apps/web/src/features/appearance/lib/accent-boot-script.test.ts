import { afterEach, describe, expect, it } from "vitest";

import { ACCENT_ATTRIBUTE, ACCENT_BOOT_SCRIPT, applyAccentAttribute, UI_STATE_STORAGE_KEY } from "./accent-boot-script";
import { DENSITY_ATTRIBUTE, FONT_ATTRIBUTE } from "./display-preferences";

const runBootScript = (): void => {
    // eslint-disable-next-line sonarjs/code-eval -- runs the inline script exactly as the browser would
    new Function(ACCENT_BOOT_SCRIPT)();
};

const store = (appearance: unknown): void => {
    localStorage.setItem(UI_STATE_STORAGE_KEY, JSON.stringify({ state: { appearance }, version: 0 }));
};

describe("accent boot script", () => {
    afterEach(() => {
        localStorage.clear();
        document.documentElement.removeAttribute(ACCENT_ATTRIBUTE);
        document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
        document.documentElement.removeAttribute(FONT_ATTRIBUTE);
    });

    it("applies stored density and font before hydration, and skips the defaults", () => {
        store({ accentColor: "default", density: "spacious", mainFont: "serif" });
        runBootScript();

        expect(document.documentElement.getAttribute(DENSITY_ATTRIBUTE)).toBe("spacious");
        expect(document.documentElement.getAttribute(FONT_ATTRIBUTE)).toBe("serif");

        // The script only ever sets attributes (it runs once per page load), so reset between the two runs.
        document.documentElement.removeAttribute(DENSITY_ATTRIBUTE);
        document.documentElement.removeAttribute(FONT_ATTRIBUTE);
        store({ density: "comfortable", mainFont: "inter" });
        runBootScript();

        expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
        expect(document.documentElement.hasAttribute(FONT_ATTRIBUTE)).toBe(false);
    });

    it("writes density and font only from their allow-lists, and leaves retired fonts on the default", () => {
        store({ density: '"><img src=x onerror=alert(1)>', mainFont: "roboto-slab" });
        runBootScript();

        expect(document.documentElement.hasAttribute(DENSITY_ATTRIBUTE)).toBe(false);
        expect(document.documentElement.hasAttribute(FONT_ATTRIBUTE)).toBe(false);
    });

    it("applies a stored preset before hydration", () => {
        store({ accentColor: "violet" });
        runBootScript();

        expect(document.documentElement.getAttribute(ACCENT_ATTRIBUTE)).toBe("violet");
    });

    it("leaves the default tokens alone for the default preset, no storage, or unknown values", () => {
        store({ accentColor: "default" });
        runBootScript();
        expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);

        localStorage.clear();
        runBootScript();
        expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);

        store({ accentColor: '"><script>alert(1)</script>' });
        runBootScript();
        expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
    });

    it("survives corrupt storage", () => {
        localStorage.setItem(UI_STATE_STORAGE_KEY, "{not json");

        expect(runBootScript).not.toThrow();
        expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
    });

    it("applyAccentAttribute sets and clears the attribute", () => {
        applyAccentAttribute("teal");
        expect(document.documentElement.getAttribute(ACCENT_ATTRIBUTE)).toBe("teal");

        applyAccentAttribute("default");
        expect(document.documentElement.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
    });
});
