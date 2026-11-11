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

/** The surfaces each shade is checked against: `--background` and `--card` of global.css, and of high contrast. */
const LIGHT_SURFACES = ["#f2f2f2", "#ffffff"] as const;
const DARK_SURFACES = ["#212121"] as const;
const CONTRAST_LIGHT_SURFACES = ["#ffffff"] as const;
const CONTRAST_DARK_SURFACES = ["#000000"] as const;

/** The bars the presets meet (`accent-presets.test.ts`, `contrast-presets.test.ts`). */
const SYSTEM_ACCENT_TEXT_CONTRAST = 4.5;
const SYSTEM_ACCENT_HIGH_TEXT_CONTRAST = 7;
const SYSTEM_ACCENT_SURFACE_CONTRAST = 3;

const MIX_STEPS = 100;

const toHex = (channels: ReadonlyArray<number>): string => `#${channels.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

/** `hex` moved `amount` (0–1) of the way to `target`, in gamma-encoded sRGB (keeps the hue). */
const mix = (hex: string, target: string, amount: number): string => {
    const channel = (color: string, index: number): number => Number.parseInt(color.slice(1 + index * 2, 3 + index * 2), 16);

    return toHex([0, 1, 2].map((index) => channel(hex, index) + (channel(target, index) - channel(hex, index)) * amount));
};

/** White or obsidian, whichever reads better on `accent`. */
const readableText = (accent: string): string => (contrastRatio(accent, WHITE) >= contrastRatio(accent, OBSIDIAN) ? WHITE : OBSIDIAN);

/**
 * The first shade of `hex`, darkened (towards black) or lightened (towards white), whose better text colour reaches
 * `textContrast` and which stands out `SYSTEM_ACCENT_SURFACE_CONTRAST` from every surface. Black and white always
 * meet both bars, so the walk always ends.
 */
const readableShade = (hex: string, towards: string, surfaces: ReadonlyArray<string>, textContrast: number): [string, string] => {
    for (let step = 0; step <= MIX_STEPS; step += 1) {
        const accent = mix(hex, towards, step / MIX_STEPS);
        const foreground = readableText(accent);

        if (
            contrastRatio(accent, foreground) >= textContrast &&
            surfaces.every((surface: string) => contrastRatio(accent, surface) >= SYSTEM_ACCENT_SURFACE_CONTRAST)
        ) {
            return [accent, foreground];
        }
    }

    return [towards, readableText(towards)];
};

/**
 * The OS accent as one shade per mode, each the closest to the OS colour that meets the presets' bars: its text
 * colour (white or obsidian, whichever reads better) at 4.5:1 (7:1 under high contrast), and 3:1 against that mode's
 * background and card. Light mode darkens, dark mode lightens.
 */
export const systemAccentTokens = (hex: string): SystemAccentTokens => {
    const base = hex.toLowerCase();
    const [light, lightForeground] = readableShade(base, BLACK, LIGHT_SURFACES, SYSTEM_ACCENT_TEXT_CONTRAST);
    const [dark, darkForeground] = readableShade(base, WHITE, DARK_SURFACES, SYSTEM_ACCENT_TEXT_CONTRAST);
    const [contrastLight, contrastLightForeground] = readableShade(base, BLACK, CONTRAST_LIGHT_SURFACES, SYSTEM_ACCENT_HIGH_TEXT_CONTRAST);
    const [contrastDark, contrastDarkForeground] = readableShade(base, WHITE, CONTRAST_DARK_SURFACES, SYSTEM_ACCENT_HIGH_TEXT_CONTRAST);

    return { contrastDark, contrastDarkForeground, contrastLight, contrastLightForeground, dark, darkForeground, light, lightForeground };
};
