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

/** The inline custom properties `:root[data-accent="system"]` reads (`accent-presets.css`). */
export const SYSTEM_ACCENT_PROPERTY = "--system-accent";
export const SYSTEM_ACCENT_FOREGROUND_PROPERTY = "--system-accent-foreground";

/** The last OS accent tokens, so the boot script can paint them before the shell answers. */
export const SYSTEM_ACCENT_CACHE_KEY = "neore-system-accent";

/** Which appearance values the user picked, as opposed to the shipped defaults. */
export type ExplicitAppearance = { accentColor?: boolean; mainFont?: boolean };

const WHITE = "#ffffff";
/** `--brand-obsidian`, the dark text the presets put on light accents. */
const OBSIDIAN = "#191919";

export interface SystemAccentTokens {
    accent: string;
    foreground: string;
}

/** White text holds on an accent down to this ratio (WCAG large-text / UI), as the OS draws it on its own blue. */
const WHITE_TEXT_MIN_CONTRAST = 3;

/**
 * The OS accent and the text colour for filled buttons: white, as the OS uses it, unless white is unreadable on a
 * light accent (yellow, orange, green), then obsidian.
 */
export const systemAccentTokens = (hex: string): SystemAccentTokens => {
    const accent = hex.toLowerCase();

    return { accent, foreground: contrastRatio(accent, WHITE) >= WHITE_TEXT_MIN_CONTRAST ? WHITE : OBSIDIAN };
};

/** Puts the OS accent tokens on `<html>`, or removes them (`null`). */
export const applySystemAccentTokens = (tokens: SystemAccentTokens | null, root: HTMLElement = document.documentElement): void => {
    if (tokens === null) {
        root.style.removeProperty(SYSTEM_ACCENT_PROPERTY);
        root.style.removeProperty(SYSTEM_ACCENT_FOREGROUND_PROPERTY);

        return;
    }

    root.style.setProperty(SYSTEM_ACCENT_PROPERTY, tokens.accent);
    root.style.setProperty(SYSTEM_ACCENT_FOREGROUND_PROPERTY, tokens.foreground);
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
