/**
 * How a site window looks before the page paints it, and the system accent colour the page may follow.
 */

/**
 * `--background` of `packages/ui/src/global.css` (`--brand-frost`, `--brand-charcoal`). The window is filled with it
 * until the page's first paint, so a dark desktop never sees a white frame.
 */
export const LIGHT_BACKGROUND = "#f2f2f2";
export const DARK_BACKGROUND = "#212121";

/** Vibrancy shows only through pixels nobody painted, so the window itself must be fully transparent. */
export const TRANSPARENT_BACKGROUND = "#00000000";

/** A page that never reaches its first paint (a hung load) still shows its window after this long. */
export const SHOW_FALLBACK_MS = 5000;

/** The sidebar material is a macOS feature: elsewhere nothing would show through a transparent sidebar. */
export const supportsVibrancy = (platform: NodeJS.Platform): boolean => platform === "darwin";

export const windowBackground = ({ dark, vibrancy }: { dark: boolean; vibrancy: boolean }): string => {
    if (vibrancy) {
        return TRANSPARENT_BACKGROUND;
    }

    return dark ? DARK_BACKGROUND : LIGHT_BACKGROUND;
};

const ACCENT_PATTERN = /^#?([\da-f]{6})(?:[\da-f]{2})?$/iu;

/**
 * `systemPreferences.getAccentColor()` and `accent-color-changed` give `RRGGBBAA`. The page gets `#rrggbb`: an accent is
 * opaque, and a CSS colour without alpha is what it can use as is. Anything else (an empty string where the desktop has
 * no accent) is `null`.
 */
export const accentHex = (raw: unknown): string | null => {
    if (typeof raw !== "string") {
        return null;
    }

    const match = ACCENT_PATTERN.exec(raw.trim());

    return match?.[1] === undefined ? null : `#${match[1].toLowerCase()}`;
};
