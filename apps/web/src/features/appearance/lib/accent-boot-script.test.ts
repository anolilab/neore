import { afterEach, describe, expect, it, vi } from "vitest";

import {
    ACCENT_ATTRIBUTE,
    ACCENT_BOOT_SCRIPT,
    applyAccentAttribute,
    NATIVE_ATTRIBUTE,
    NATIVE_VIBRANCY_ATTRIBUTE,
    UI_STATE_STORAGE_KEY,
} from "./accent-boot-script";
import { DEFAULT_ACCENT } from "./accent-presets";
import { CONTRAST_ATTRIBUTE, DEFAULT_MAIN_FONT, DENSITY_ATTRIBUTE, FONT_ATTRIBUTE, PREFERS_MORE_CONTRAST_QUERY } from "./display-preferences";
import { effectiveAccent, effectiveMainFont, isExplicit, SYSTEM_ACCENT_CACHE_KEY, SYSTEM_ACCENT_PROPERTIES } from "./native-appearance";
import { systemAccentTokens } from "./system-accent-tokens";

/** What could end an inline script early: a closing tag, a comment opener, or a raw line separator. */
const SCRIPT_BREAKOUT = /<\/|<!--|[\u{2028}\u{2029}]/u;

const BLUE_TOKENS = systemAccentTokens("#007aff");

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
        document.documentElement.removeAttribute(CONTRAST_ATTRIBUTE);
        document.documentElement.removeAttribute(NATIVE_ATTRIBUTE);
        document.documentElement.removeAttribute(NATIVE_VIBRANCY_ATTRIBUTE);
        document.documentElement.removeAttribute("spellcheck");
        document.documentElement.removeAttribute("style");
        vi.unstubAllGlobals();
    });

    describe("desktop shell", () => {
        const shell = (capabilities: string[]) => {
            vi.stubGlobal("neoreNative", { capabilities });
        };
        const cacheAccent = () => {
            localStorage.setItem(SYSTEM_ACCENT_CACHE_KEY, JSON.stringify(BLUE_TOKENS));
        };
        const html = document.documentElement;

        it("adds nothing in a browser", () => {
            cacheAccent();
            runBootScript();

            expect(html.hasAttribute(NATIVE_ATTRIBUTE)).toBe(false);
            expect(html.hasAttribute("spellcheck")).toBe(false);
            expect(html.hasAttribute(FONT_ATTRIBUTE)).toBe(false);
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
        });

        it("marks the shell, its vibrancy, and turns spellcheck off", () => {
            shell(["vibrancy"]);
            runBootScript();

            expect(html.getAttribute(NATIVE_ATTRIBUTE)).toBe("");
            expect(html.getAttribute(NATIVE_VIBRANCY_ATTRIBUTE)).toBe("");
            expect(html.getAttribute("spellcheck")).toBe("false");
        });

        it("leaves vibrancy off without the capability", () => {
            shell([]);
            runBootScript();

            expect(html.hasAttribute(NATIVE_ATTRIBUTE)).toBe(true);
            expect(html.hasAttribute(NATIVE_VIBRANCY_ATTRIBUTE)).toBe(false);
        });

        it("uses the system font for an untouched default, and keeps an explicit one", () => {
            shell([]);
            runBootScript();
            expect(html.getAttribute(FONT_ATTRIBUTE)).toBe("system");

            html.removeAttribute(FONT_ATTRIBUTE);
            store({ explicit: { mainFont: true }, mainFont: "inter" });
            runBootScript();
            expect(html.hasAttribute(FONT_ATTRIBUTE)).toBe(false);

            store({ mainFont: "serif" });
            runBootScript();
            expect(html.getAttribute(FONT_ATTRIBUTE)).toBe("serif");
        });

        it("paints the cached OS accent for an untouched default or a stored `system`", () => {
            shell(["system-accent"]);
            cacheAccent();
            runBootScript();
            expect(html.getAttribute(ACCENT_ATTRIBUTE)).toBe("system");
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.light)).toBe(BLUE_TOKENS.light);
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.dark)).toBe(BLUE_TOKENS.dark);
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.contrastLightForeground)).toBe(BLUE_TOKENS.contrastLightForeground);
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.lightText)).toBe(BLUE_TOKENS.lightText);
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.contrastDarkHover)).toBe(BLUE_TOKENS.contrastDarkHover);

            html.removeAttribute(ACCENT_ATTRIBUTE);
            store({ accentColor: "system", explicit: { accentColor: true } });
            runBootScript();
            expect(html.getAttribute(ACCENT_ATTRIBUTE)).toBe("system");
        });

        it("keeps an explicit preset, and needs the capability and a valid cache", () => {
            shell(["system-accent"]);
            cacheAccent();
            store({ accentColor: "default", explicit: { accentColor: true } });
            runBootScript();
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);

            shell([]);
            store({ accentColor: "system" });
            runBootScript();
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);

            shell(["system-accent"]);
            localStorage.setItem(SYSTEM_ACCENT_CACHE_KEY, JSON.stringify({ ...BLUE_TOKENS, dark: "red;}" }));
            runBootScript();
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
            expect(html.style.getPropertyValue(SYSTEM_ACCENT_PROPERTIES.light)).toBe("");

            // A cache from before the text and hover shades would leave `--primary-text` unset: it waits for the shell too.
            const withoutTextAndHover: Partial<typeof BLUE_TOKENS> = { ...BLUE_TOKENS };

            delete withoutTextAndHover.lightText;
            delete withoutTextAndHover.darkHover;

            localStorage.setItem(SYSTEM_ACCENT_CACHE_KEY, JSON.stringify(withoutTextAndHover));
            runBootScript();
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);

            // A cache from before the per-mode tokens waits for the shell's answer.
            localStorage.setItem(SYSTEM_ACCENT_CACHE_KEY, JSON.stringify({ accent: "#007aff", foreground: "#ffffff" }));
            runBootScript();
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
        });

        it("treats a retired accent or font id as the untouched default, as the runtime does", () => {
            shell(["system-accent"]);
            cacheAccent();
            store({ accentColor: "lime", mainFont: "comic" });
            runBootScript();

            expect(html.getAttribute(ACCENT_ATTRIBUTE)).toBe("system");
            expect(html.getAttribute(FONT_ATTRIBUTE)).toBe("system");
        });

        it("counts only an explicit flag of exactly true", () => {
            shell(["system-accent"]);
            cacheAccent();
            store({ accentColor: "default", explicit: { accentColor: "yes", mainFont: 1 }, mainFont: "inter" });
            runBootScript();

            expect(html.getAttribute(ACCENT_ATTRIBUTE)).toBe("system");
            expect(html.getAttribute(FONT_ATTRIBUTE)).toBe("system");
        });

        it("counts a synced mark as explicit, like a choice made here", () => {
            shell(["system-accent"]);
            cacheAccent();
            store({ accentColor: "default", explicit: { accentColor: "synced", mainFont: "synced" }, mainFont: "inter" });
            runBootScript();

            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
            expect(html.hasAttribute(FONT_ATTRIBUTE)).toBe(false);
        });

        // The same rule as the runtime helpers, for every kind of mark: what the boot script paints is what AppearanceSync keeps.
        const MARKS = [undefined, true, false, "synced", "yes", 1] as const;
        const ACCENTS = ["default", "teal", "system", "lime", undefined] as const;
        const FONTS = ["inter", "serif", "system", "comic", undefined] as const;

        it("matches effectiveAccent / effectiveMainFont for every mark, accent, font and OS accent", () => {
            const cases = MARKS.flatMap((mark) =>
                ACCENTS.flatMap((accentColor) => FONTS.flatMap((mainFont) => [true, false].map((capable) => [mark, accentColor, mainFont, capable] as const))),
            );

            expect(cases).toHaveLength(300);

            for (const [mark, accentColor, mainFont, capable] of cases) {
                html.removeAttribute(ACCENT_ATTRIBUTE);
                html.removeAttribute(FONT_ATTRIBUTE);
                html.removeAttribute("style");
                shell(capable ? ["system-accent"] : []);
                cacheAccent();
                store({ accentColor, explicit: { accentColor: mark, mainFont: mark }, mainFont });
                runBootScript();

                const accent = effectiveAccent(accentColor, isExplicit(mark), capable);
                const font = effectiveMainFont(mainFont, isExplicit(mark), true);
                const label = JSON.stringify({ accentColor, capable, mainFont, mark });

                expect(html.getAttribute(ACCENT_ATTRIBUTE), label).toBe(accent === DEFAULT_ACCENT ? null : accent);
                expect(html.getAttribute(FONT_ATTRIBUTE), label).toBe(font === DEFAULT_MAIN_FONT ? null : font);
            }
        });

        it("keeps a retired id with an explicit flag on the default preset and font", () => {
            shell(["system-accent"]);
            cacheAccent();
            store({ accentColor: "lime", explicit: { accentColor: true, mainFont: true }, mainFont: "comic" });
            runBootScript();

            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
            expect(html.hasAttribute(FONT_ATTRIBUTE)).toBe(false);
        });

        it("still marks the shell when the stored state is corrupt", () => {
            shell(["vibrancy", "system-accent"]);
            cacheAccent();
            localStorage.setItem(UI_STATE_STORAGE_KEY, "{not json");
            runBootScript();

            expect(html.getAttribute(NATIVE_ATTRIBUTE)).toBe("");
            expect(html.getAttribute(NATIVE_VIBRANCY_ATTRIBUTE)).toBe("");
            expect(html.getAttribute("spellcheck")).toBe("false");
            expect(html.getAttribute(FONT_ATTRIBUTE)).toBe("system");
            expect(html.getAttribute(ACCENT_ATTRIBUTE)).toBe("system");
        });

        it("still marks the shell when storage throws", () => {
            shell(["vibrancy"]);
            vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
                throw new DOMException("denied", "SecurityError");
            });

            try {
                expect(runBootScript).not.toThrow();
            } finally {
                vi.restoreAllMocks();
            }

            expect(html.getAttribute(NATIVE_ATTRIBUTE)).toBe("");
            expect(html.getAttribute(NATIVE_VIBRANCY_ATTRIBUTE)).toBe("");
            expect(html.getAttribute("spellcheck")).toBe("false");
            expect(html.hasAttribute(ACCENT_ATTRIBUTE)).toBe(false);
        });
    });

    describe("contrast", () => {
        const systemPrefersMore = (matches: boolean) => {
            vi.stubGlobal("matchMedia", (query: string) => {
                return { matches: matches && query.includes("prefers-contrast: more") };
            });
        };

        it("hard-codes the contrast literals the script writes, so they cannot drift from the constants", () => {
            expect(ACCENT_BOOT_SCRIPT).toContain(`matchMedia("${PREFERS_MORE_CONTRAST_QUERY}")`);
            expect(ACCENT_BOOT_SCRIPT).toContain(`setAttribute("${CONTRAST_ATTRIBUTE}","high")`);
        });

        it("applies a stored high choice whatever the system says", () => {
            systemPrefersMore(false);
            store({ contrast: "high" });
            runBootScript();

            expect(document.documentElement.getAttribute(CONTRAST_ATTRIBUTE)).toBe("high");
        });

        it("follows the system when nothing is stored or `system` is", () => {
            systemPrefersMore(true);
            runBootScript();
            expect(document.documentElement.getAttribute(CONTRAST_ATTRIBUTE)).toBe("high");

            document.documentElement.removeAttribute(CONTRAST_ATTRIBUTE);
            store({ contrast: "system" });
            runBootScript();
            expect(document.documentElement.getAttribute(CONTRAST_ATTRIBUTE)).toBe("high");
        });

        it("lets an explicit standard choice beat the system", () => {
            systemPrefersMore(true);
            store({ contrast: "standard" });
            runBootScript();

            expect(document.documentElement.hasAttribute(CONTRAST_ATTRIBUTE)).toBe(false);
        });

        it("stays off without the system preference or a choice", () => {
            systemPrefersMore(false);
            runBootScript();

            expect(document.documentElement.hasAttribute(CONTRAST_ATTRIBUTE)).toBe(false);
        });
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

    it("holds nothing that could close its script element", () => {
        expect(ACCENT_BOOT_SCRIPT).not.toMatch(SCRIPT_BREAKOUT);
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
