import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buttonVariants } from "@neore/ui/components/button";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ACCENT_PRESETS } from "./lib/accent-presets";
import { applySystemAccentTokens } from "./lib/native-appearance";
import { systemAccentTokens } from "./lib/system-accent-tokens";

/** LF-normalised. The path is a variable on purpose: Vite rewrites a literal `new URL("….css", import.meta.url)` into an asset import. */
const readRelative = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replaceAll("\r\n", "\n");

const GLOBAL_CSS = "../../../../../packages/ui/src/global.css";
const ACCENT_CSS = "./accent-presets.css";
const CONTRAST_CSS = "./contrast-presets.css";

const require = createRequire(import.meta.url);

const WHITESPACE = /\s+/u;

/** The stylesheet of `packages/ui/src/global.css` through Tailwind, with only the utilities the default Button uses. */
const buildButtonCss = async (classes: ReadonlyArray<string>): Promise<string> => {
    const compiler = await compile(readRelative(GLOBAL_CSS), {
        // Only Tailwind itself matters here: the animation and shadcn sheets and the typography plugin add no colour.
        loadModule: async () => {
            return { base: "", module: () => {}, path: "" };
        },
        loadStylesheet: async (id: string) => {
            if (id !== "tailwindcss") {
                return { base: "", content: "", path: "" };
            }

            const path = require.resolve("tailwindcss/index.css");

            return { base: dirname(path), content: readFileSync(path, "utf8"), path };
        },
    });

    return compiler.build([...classes]);
};

const BLACK = "rgb(0, 0, 0)";

const rgb = (hex: string): string => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));

    return `rgb(${channels.join(", ")})`;
};

/** A dark OS accent (macOS graphite-ish blue): its light-mode shade carries white text. */
const DARK_OS_ACCENT = "#1f3a93";

describe("the default Button's label", () => {
    const root = document.documentElement;
    let button: HTMLButtonElement;

    beforeAll(async () => {
        const classes = buttonVariants().split(WHITESPACE);
        const style = document.createElement("style");

        style.textContent = [await buildButtonCss(classes), readRelative(ACCENT_CSS), readRelative(CONTRAST_CSS)].join("\n");
        document.head.insertAdjacentElement("beforeend", style);

        button = document.createElement("button");
        button.className = buttonVariants();
        document.body.insertAdjacentElement("beforeend", button);
    });

    afterAll(() => {
        document.head.replaceChildren();
        document.body.replaceChildren();
        delete root.dataset.accent;
        delete root.dataset.contrast;
        root.classList.remove("dark");
        applySystemAccentTokens(null);
    });

    const paint = (accent: string, mode: "dark" | "light", contrast: "high" | "normal"): string => {
        root.dataset.accent = accent;
        root.classList.toggle("dark", mode === "dark");

        if (contrast === "high") {
            root.dataset.contrast = "high";
        } else {
            delete root.dataset.contrast;
        }

        return getComputedStyle(button).color;
    };

    const VARIANTS = (["light", "dark"] as const).flatMap((mode) => (["normal", "high"] as const).map((contrast) => [mode, contrast] as const));

    // The presets keep the black label they always had, whatever their `--primary-foreground`.
    it.each(ACCENT_PRESETS.flatMap((preset) => VARIANTS.map(([mode, contrast]) => [preset.id, mode, contrast] as const)))(
        "stays black on %s (%s, %s contrast)",
        (id, mode, contrast) => {
            expect(paint(id, mode, contrast)).toBe(BLACK);
        },
    );

    it.each(VARIANTS)("follows the computed foreground of the OS accent (%s, %s contrast)", (mode, contrast) => {
        const tokens = systemAccentTokens(DARK_OS_ACCENT);

        applySystemAccentTokens(tokens);

        const foregrounds = {
            high: { dark: tokens.contrastDarkForeground, light: tokens.contrastLightForeground },
            normal: { dark: tokens.darkForeground, light: tokens.lightForeground },
        };

        expect(paint("system", mode, contrast)).toBe(rgb(foregrounds[contrast][mode]));
    });

    it("is white on a dark OS accent in light mode", () => {
        expect(systemAccentTokens(DARK_OS_ACCENT).lightForeground).toBe("#ffffff");
    });
});
