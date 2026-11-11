import type { AccentId } from "./accent-presets";
import { DEFAULT_ACCENT, isAccentId } from "./accent-presets";
import { contrastRatio } from "./color-contrast";
import type { MainFontId } from "./display-preferences";
import { DEFAULT_MAIN_FONT, isMainFontId } from "./display-preferences";

/**
 * Appearance defaults inside the desktop shell (`apps/desktop`).
 *
 * - `system` accent: the OS accent colour, offered only when the shell advertises `system-accent`. It is a
 *   per-device choice, so it is never written to `userSettings` (whose validator knows only the presets).
 * - With nothing chosen, the shell paints the OS accent and the system font instead of the brand lime and Geist.
 *   An explicit choice (here, or synced from another device) always wins.
 */

export const SYSTEM_ACCENT = "system";

/** What the accent setting can hold: a preset, or the OS accent colour. */
export type AccentChoice = AccentId | typeof SYSTEM_ACCENT;

export const isAccentChoice = (value: unknown): value is AccentChoice => value === SYSTEM_ACCENT || isAccentId(value);

/**
 * The inline custom properties `:root[data-accent="system"]` reads (`accent-presets.css` for each mode,
 * `contrast-presets.css` under high contrast): one shade of the OS accent per mode, each with its text colour.
 */
export const SYSTEM_ACCENT_PROPERTIES = {
    contrastDark: "--system-accent-contrast-dark",
    contrastDarkForeground: "--system-accent-contrast-dark-foreground",
    contrastLight: "--system-accent-contrast-light",
    contrastLightForeground: "--system-accent-contrast-light-foreground",
    dark: "--system-accent-dark",
    darkForeground: "--system-accent-dark-foreground",
    light: "--system-accent-light",
    lightForeground: "--system-accent-light-foreground",
} as const;

/** The last OS accent tokens, so the boot script can paint them before the shell answers. */
export const SYSTEM_ACCENT_CACHE_KEY = "neore-system-accent";

/** Which appearance values the user picked, as opposed to the shipped defaults. */
export type ExplicitAppearance = { accentColor?: boolean; mainFont?: boolean };

/** Each value is a lower-case `#rrggbb`. */
export type SystemAccentTokens = Record<keyof typeof SYSTEM_ACCENT_PROPERTIES, string>;

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

const SYSTEM_ACCENT_KEYS = Object.keys(SYSTEM_ACCENT_PROPERTIES) as (keyof typeof SYSTEM_ACCENT_PROPERTIES)[];

/** Puts the OS accent tokens on `<html>`, or removes them (`null`). */
export const applySystemAccentTokens = (tokens: SystemAccentTokens | null, root: HTMLElement = document.documentElement): void => {
    for (const key of SYSTEM_ACCENT_KEYS) {
        if (tokens === null) {
            root.style.removeProperty(SYSTEM_ACCENT_PROPERTIES[key]);
        } else {
            root.style.setProperty(SYSTEM_ACCENT_PROPERTIES[key], tokens[key]);
        }
    }
};

/** Remembers the tokens for the next boot; `null` forgets them. Storage failures are ignored. */
export const cacheSystemAccentTokens = (tokens: SystemAccentTokens | null): void => {
    try {
        if (tokens === null) {
            localStorage.removeItem(SYSTEM_ACCENT_CACHE_KEY);
        } else {
            localStorage.setItem(SYSTEM_ACCENT_CACHE_KEY, JSON.stringify(tokens));
        }
    } catch {
        // Private mode or blocked storage: the next boot paints the preset until the shell answers.
    }
};

/**
 * The accent to paint. A stored `system` falls back to the default preset where the shell offers no OS accent;
 * with the OS accent available and no explicit choice (a never-touched default), the OS accent is the default.
 */
export const effectiveAccent = (accentColor: unknown, explicit: boolean, systemAccentAvailable: boolean): AccentChoice => {
    if (accentColor === SYSTEM_ACCENT) {
        return systemAccentAvailable ? SYSTEM_ACCENT : DEFAULT_ACCENT;
    }

    const preset = isAccentId(accentColor) ? accentColor : DEFAULT_ACCENT;

    // A non-default preset is a choice even when it predates the explicit flag.
    return systemAccentAvailable && !explicit && preset === DEFAULT_ACCENT ? SYSTEM_ACCENT : preset;
};

/** The main font to paint: in the shell, an untouched default is the system face; any explicit choice wins. */
export const effectiveMainFont = (mainFont: unknown, explicit: boolean, isNative: boolean): MainFontId => {
    const font = isMainFontId(mainFont) ? mainFont : DEFAULT_MAIN_FONT;

    return isNative && !explicit && font === DEFAULT_MAIN_FONT ? "system" : font;
};
