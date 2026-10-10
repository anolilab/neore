import { afterEach, describe, expect, it } from "vitest";

import { ACCENT_ATTRIBUTE, ACCENT_BOOT_SCRIPT, applyAccentAttribute, UI_STATE_STORAGE_KEY } from "./accent-boot-script";

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
