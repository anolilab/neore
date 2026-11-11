import { contrastRatio } from "./color-contrast";
import type { SystemAccentTokens } from "./native-appearance";

/**
 * The OS accent maths, apart from `native-appearance.ts` so only the desktop shell downloads it: `AppearanceSync`
 * imports this module dynamically once the `system` accent applies.
 */

const WHITE = "#ffffff";
/** `--brand-obsidian`, the dark text the presets put on light accents. */
const OBSIDIAN = "#191919";
const BLACK = "#000000";

/** The surfaces each shade is checked against (as text, too): `--background` and `--card` of global.css, and of high contrast. */
const LIGHT_SURFACES = ["#f2f2f2", "#ffffff"] as const;
const DARK_SURFACES = ["#212121"] as const;
const CONTRAST_LIGHT_SURFACES = ["#ffffff"] as const;
const CONTRAST_DARK_SURFACES = ["#000000"] as const;

/** The bars the presets meet (`accent-presets.test.ts`, `contrast-presets.test.ts`). */
const SYSTEM_ACCENT_TEXT_CONTRAST = 4.5;
const SYSTEM_ACCENT_HIGH_TEXT_CONTRAST = 7;
const SYSTEM_ACCENT_SURFACE_CONTRAST = 3;

const MIX_STEPS = 100;
/** How far the hover shade moves from the fill, largest first: the most visible step that keeps every bar. */
const HOVER_MIXES = [0.15, 0.12, 0.09, 0.06] as const;

const toHex = (channels: ReadonlyArray<number>): string => `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/** `hex` moved `amount` (0–1) of the way to `target`, in gamma-encoded sRGB (keeps the hue). */
const mix = (hex: string, target: string, amount: number): string => {
    const channel = (color: string, index: number): number => Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);

    return toHex([0, 1, 2].map((index) => channel(hex, index) + (channel(target, index) - channel(hex, index)) * amount));
};

/** White or obsidian, whichever reads better on `accent`. */
const readableText = (accent: string): string => (contrastRatio(accent, WHITE) >= contrastRatio(accent, OBSIDIAN) ? WHITE : OBSIDIAN);

/** The first shade of `hex` on the way to `towards` (black or white) that `passes`; black and white pass every bar used here. */
const firstShade = (hex: string, towards: string, passes: (shade: string) => boolean): string => {
    for (let step = 0; step <= MIX_STEPS; step += 1) {
        const shade = mix(hex, towards, step / MIX_STEPS);

        if (passes(shade)) {
            return shade;
        }
    }

    return towards;
};

type ModeShades = { fill: string; foreground: string; hover: string; text: string };

/**
 * One mode's shades of `hex`, darkened (towards black) or lightened (towards white):
 * - `fill`, the closest whose better label reaches `textContrast` and which stands out
 *   `SYSTEM_ACCENT_SURFACE_CONTRAST` from every surface, with that label as `foreground`;
 * - `hover`, the fill moved away from its label, so the label keeps its contrast on hover (a translucent
 *   `bg-primary/80` would blend it towards the surface);
 * - `text`, the closest that reads at `textContrast` as text on every surface (links, `--primary-text`).
 */
const modeShades = (hex: string, towards: string, surfaces: ReadonlyArray<string>, textContrast: number): ModeShades => {
    const fill = firstShade(
        hex,
        towards,
        (shade) =>
            contrastRatio(shade, readableText(shade)) >= textContrast &&
            surfaces.every((surface: string) => contrastRatio(shade, surface) >= SYSTEM_ACCENT_SURFACE_CONTRAST),
    );
    const foreground = readableText(fill);
    const text = firstShade(hex, towards, (shade) => surfaces.every((surface: string) => contrastRatio(shade, surface) >= textContrast));
    // The first visible step that keeps both the label's contrast and the 3:1 against every surface: away from the
    // label, then deeper into the mode (a fill at its 3:1 limit fades into the page when lightened), then towards the label.
    const hoverPasses = (shade: string): boolean =>
        shade !== fill &&
        contrastRatio(shade, foreground) >= textContrast &&
        surfaces.every((surface: string) => contrastRatio(shade, surface) >= SYSTEM_ACCENT_SURFACE_CONTRAST);
    const hover =
        [foreground === WHITE ? BLACK : WHITE, towards, foreground]
            .flatMap((target) => HOVER_MIXES.map((amount) => mix(fill, target, amount)))
            .find((shade) => hoverPasses(shade)) ?? fill;

    return { fill, foreground, hover, text };
};

/**
 * The OS accent per mode, each shade the closest to the OS colour that meets the presets' bars: its label (white or
 * obsidian, whichever reads better) at 4.5:1 (7:1 under high contrast) on the fill and on its hover, the fill 3:1
 * against that mode's background and card, and the text shade at 4.5:1 (7:1) on them. Light mode darkens, dark mode
 * lightens.
 */
export const systemAccentTokens = (hex: string): SystemAccentTokens => {
    const base = hex.toLowerCase();
    const light = modeShades(base, BLACK, LIGHT_SURFACES, SYSTEM_ACCENT_TEXT_CONTRAST);
    const dark = modeShades(base, WHITE, DARK_SURFACES, SYSTEM_ACCENT_TEXT_CONTRAST);
    const contrastLight = modeShades(base, BLACK, CONTRAST_LIGHT_SURFACES, SYSTEM_ACCENT_HIGH_TEXT_CONTRAST);
    const contrastDark = modeShades(base, WHITE, CONTRAST_DARK_SURFACES, SYSTEM_ACCENT_HIGH_TEXT_CONTRAST);

    return {
        contrastDark: contrastDark.fill,
        contrastDarkForeground: contrastDark.foreground,
        contrastDarkHover: contrastDark.hover,
        contrastDarkText: contrastDark.text,
        contrastLight: contrastLight.fill,
        contrastLightForeground: contrastLight.foreground,
        contrastLightHover: contrastLight.hover,
        contrastLightText: contrastLight.text,
        dark: dark.fill,
        darkForeground: dark.foreground,
        darkHover: dark.hover,
        darkText: dark.text,
        light: light.fill,
        lightForeground: light.foreground,
        lightHover: light.hover,
        lightText: light.text,
    };
};
