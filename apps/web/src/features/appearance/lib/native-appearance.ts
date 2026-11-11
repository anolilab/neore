import type { AccentId } from "./accent-presets";
import { DEFAULT_ACCENT, isAccentId } from "./accent-presets";
import type { MainFontId } from "./display-preferences";
import { DEFAULT_MAIN_FONT, isMainFontId } from "./display-preferences";

/**
 * Appearance defaults inside the desktop shell (`apps/desktop`).
 *
 * - `system` accent: the OS accent colour, offered only when the shell advertises `system-accent`. It is a
 *   per-device choice, so it is never written to `userSettings` (whose validator knows only the presets).
 * - With nothing chosen, the shell paints the OS accent and the system font instead of the brand lime and Geist.
 *   An explicit choice (here, or synced from the signed-in account) always wins; a synced one lasts only as long as
 *   that account stays signed in (`withoutSyncedChoices`).
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

/** A value adopted from the signed-in account's `userSettings`, as opposed to one picked on this device. */
export const SYNCED_MARK = "synced";

/**
 * How a value came to be chosen: `true` picked on this device (and every mark stored before the two were told apart),
 * `synced` adopted from the account. Both count as explicit.
 */
export type ExplicitMark = boolean | typeof SYNCED_MARK;

/** Which appearance values the user picked, as opposed to the shipped defaults. */
export type ExplicitAppearance = { accentColor?: ExplicitMark; mainFont?: ExplicitMark };

/** The marks that count as a choice. The boot script embeds this list, so it reads a mark exactly as `isExplicit` does. */
export const EXPLICIT_MARKS: ReadonlyArray<unknown> = [true, SYNCED_MARK];

export const isExplicit = (mark: unknown): boolean => EXPLICIT_MARKS.includes(mark);

/**
 * The mark for a value adopted from the account. The account echoing back what was picked on this device (a save, then
 * a refetch) keeps it this device's choice, so switching accounts does not reset it.
 */
export const adoptedMark = (current: ExplicitMark | undefined, sameValue: boolean): ExplicitMark => (sameValue && current === true ? true : SYNCED_MARK);

type SyncedChoiceReset = { accentColor?: AccentId; explicit: ExplicitAppearance; mainFont?: MainFontId };

/**
 * The appearance changes that drop what another account synced: each `synced` value goes back to its default, unmarked,
 * so the shell's defaults apply again. A choice made on this device stays.
 */
export const withoutSyncedChoices = (explicit: ExplicitAppearance | undefined): SyncedChoiceReset => {
    const changes: SyncedChoiceReset = { explicit: {} };

    if (explicit?.accentColor === SYNCED_MARK) {
        changes.accentColor = DEFAULT_ACCENT;
        changes.explicit.accentColor = undefined;
    }

    if (explicit?.mainFont === SYNCED_MARK) {
        changes.mainFont = DEFAULT_MAIN_FONT;
        changes.explicit.mainFont = undefined;
    }

    return changes;
};

/** Each value is a lower-case `#rrggbb`. */
export type SystemAccentTokens = Record<keyof typeof SYSTEM_ACCENT_PROPERTIES, string>;

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
