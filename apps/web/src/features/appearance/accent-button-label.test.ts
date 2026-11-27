import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buttonVariants } from "@neore/ui/components/button";
import { compile } from "tailwindcss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ACCENT_PRESETS } from "./lib/accent-presets";
import { contrastRatio } from "./lib/color-contrast";
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

/** The macOS accent palette (System Settings > Appearance), as in native-appearance.test.ts. */
const MACOS_ACCENTS = ["#007aff", "#953d96", "#f74f9e", "#e0383e", "#f7821b", "#ffc600", "#62ba46", "#8c8c8c"] as const;

/** `--background` and `--card` per mode, plain and high contrast: what a translucent hover blends with. */
const SURFACES = {
    high: { dark: ["#000000"], light: ["#ffffff"] },
    normal: { dark: ["#212121"], light: ["#f2f2f2", "#ffffff"] },
} as const;

const RGB = /^rgba?\((?<r>[\d.]+), (?<g>[\d.]+), (?<b>[\d.]+)(?:, (?<alpha>[\d.]+))?\)$/u;
const OKLAB = /^oklab\((?<l>[-\d.e]+) (?<a>[-\d.e]+) (?<b>[-\d.e]+)(?: \/ (?<alpha>[\d.]+))?\)$/u;

const toHex = (channels: ReadonlyArray<number>): string =>
    `#${channels
        .map((channel) =>
            Math.round(Math.min(255, Math.max(0, channel)))
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;

const encode = (linear: number): number => 255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055);

/** A computed colour (`rgb()`, `rgba()`, or the `oklab()` jsdom resolves `color-mix()` to) as 0–255 sRGB channels and alpha. */
const parseComputed = (color: string): { alpha: number; channels: [number, number, number] } => {
    const rgbGroups = RGB.exec(color)?.groups;

    if (rgbGroups) {
        return { alpha: Number(rgbGroups.alpha ?? 1), channels: [Number(rgbGroups.r), Number(rgbGroups.g), Number(rgbGroups.b)] };
    }

    const lab = OKLAB.exec(color)?.groups;

    if (!lab) {
        throw new Error(`Unexpected computed colour: ${color}`);
    }

    const [l, a, b] = [Number(lab.l), Number(lab.a), Number(lab.b)];
    const lms = [l + 0.3963377774 * a + 0.2158037573 * b, l - 0.1055613458 * a - 0.0638541728 * b, l - 0.0894841775 * a - 1.291485548 * b].map(
        (value) => value ** 3,
    ) as [number, number, number];

    return {
        alpha: Number(lab.alpha ?? 1),
        channels: [
            encode(4.0767416621 * lms[0] - 3.3077115913 * lms[1] + 0.2309699292 * lms[2]),
            encode(-1.2684380046 * lms[0] + 2.6097574011 * lms[1] - 0.3413193965 * lms[2]),
            encode(-0.0041960863 * lms[0] - 0.7034186147 * lms[1] + 1.707614701 * lms[2]),
        ],
    };
};

/** `color` painted over the opaque `surface`, as `#rrggbb`. */
const over = (color: string, surface: string): string => {
    const { alpha, channels } = parseComputed(color);
    const base = parseComputed(rgb(surface)).channels;

    return toHex(channels.map((channel, index) => channel * alpha + base[index]! * (1 - alpha)));
};

/** The default Button's hover background utility, without its `hover:` variant, so jsdom can compute it at rest. */
const HOVER_BACKGROUND = buttonVariants()
    .split(WHITESPACE)
    .find((name) => name.startsWith("hover:bg-"))
    ?.slice("hover:".length);

describe("the default Button's label and the accent text", () => {
    const root = document.documentElement;
    let button: HTMLButtonElement;
    /** Carries the hover background at rest. */
    let hovered: HTMLSpanElement;
    /** The 80% fill the default Button hovered with before the OS accent had its own shade. */
    let translucent: HTMLSpanElement;
    /** Accent-coloured text, as links use. */
    let accentText: HTMLAnchorElement;

    beforeAll(async () => {
        const classes = [...buttonVariants().split(WHITESPACE), HOVER_BACKGROUND ?? "", "bg-primary/80", "text-primary-text"];
        const style = document.createElement("style");

        style.textContent = [await buildButtonCss(classes), readRelative(ACCENT_CSS), readRelative(CONTRAST_CSS)].join("\n");
        document.head.insertAdjacentElement("beforeend", style);

        button = document.createElement("button");
        button.className = buttonVariants();
        hovered = document.createElement("span");
        hovered.className = HOVER_BACKGROUND ?? "";
        translucent = document.createElement("span");
        translucent.className = "bg-primary/80";
        accentText = document.createElement("a");
        accentText.className = "text-primary-text";

        for (const element of [button, hovered, translucent, accentText]) {
            document.body.insertAdjacentElement("beforeend", element);
        }
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

    // `bg-primary/80` blends the fill towards the surface: on the OS accent the label fell to ~3.2:1 there.
    describe.each(MACOS_ACCENTS)("on hover over the OS accent %s", (hex) => {
        it.each(VARIANTS)(`keeps the label at its bar on every surface (%s, %s contrast)`, (mode, contrast) => {
            applySystemAccentTokens(systemAccentTokens(hex));

            const label = paint("system", mode, contrast);
            const background = getComputedStyle(hovered).backgroundColor;
            const bar = contrast === "high" ? 7 : 4.5;
            const surfaces = SURFACES[contrast][mode];

            for (const surface of surfaces) {
                expect(contrastRatio(over(label, surface), over(background, surface)), `${background} over ${surface}`).toBeGreaterThanOrEqual(bar);
            }
        });
    });

    // `--primary` need only stand out 3:1 from the page; as text it must read at 4.5:1 (7:1 under high contrast).
    describe.each(MACOS_ACCENTS)("accent-coloured text with the OS accent %s", (hex) => {
        it.each(VARIANTS)("reads at its bar on every surface (%s, %s contrast)", (mode, contrast) => {
            applySystemAccentTokens(systemAccentTokens(hex));
            paint("system", mode, contrast);

            const text = getComputedStyle(accentText).color;
            const surfaces = SURFACES[contrast][mode];

            for (const surface of surfaces) {
                expect(contrastRatio(over(text, surface), surface), `${text} on ${surface}`).toBeGreaterThanOrEqual(contrast === "high" ? 7 : 4.5);
            }
        });
    });

    it.each(ACCENT_PRESETS.flatMap((preset) => VARIANTS.map(([mode, contrast]) => [preset.id, mode, contrast] as const)))(
        "hovers to the 80% fill on %s, as before (%s, %s contrast)",
        (id, mode, contrast) => {
            paint(id, mode, contrast);

            expect(getComputedStyle(hovered).backgroundColor).toBe(getComputedStyle(translucent).backgroundColor);
        },
    );

    it("is white on a dark OS accent in light mode", () => {
        expect(systemAccentTokens(DARK_OS_ACCENT).lightForeground).toBe("#ffffff");
    });
});
