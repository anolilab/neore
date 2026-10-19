/**
 * UI density and font family. Both live in the `appearance` slice of the UI
 * store and are mirrored to `userSettings` like the accent (see
 * `useAppearanceSettings`). The DOM sees them as `data-density` and
 * `data-font` on `<html>`; `styles.css` maps each value to CSS custom
 * properties, so components only consume tokens.
 */

export const DENSITY_IDS = ["compact", "comfortable", "spacious"] as const;

export type DensityId = (typeof DENSITY_IDS)[number];

export const DEFAULT_DENSITY: DensityId = "comfortable";

/** Font families. `inter` is the default sans face (the bundled Geist); no web font is downloaded for any choice. */
export const MAIN_FONT_IDS = ["inter", "system", "serif", "mono", "dyslexic"] as const;

export type MainFontId = (typeof MAIN_FONT_IDS)[number];

export const DEFAULT_MAIN_FONT: MainFontId = "inter";

export const DENSITY_ATTRIBUTE = "data-density";

export const FONT_ATTRIBUTE = "data-font";

const DENSITY_ID_SET: ReadonlySet<string> = new Set(DENSITY_IDS);
const MAIN_FONT_ID_SET: ReadonlySet<string> = new Set(MAIN_FONT_IDS);

export const isDensityId = (value: unknown): value is DensityId => typeof value === "string" && DENSITY_ID_SET.has(value);

/** Unknown or retired values (e.g. the old `roboto-slab`) are not offered and fall back to the default sans. */
export const isMainFontId = (value: unknown): value is MainFontId => typeof value === "string" && MAIN_FONT_ID_SET.has(value);
