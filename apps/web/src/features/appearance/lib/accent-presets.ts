/**
 * Accent colour presets — the single source of truth.
 *
 * `accent-presets.css` is GENERATED from this module by `renderAccentCss()`
 * (`accent-presets.test.ts` fails when the two drift and prints the fresh
 * output), and the same test asserts every preset meets WCAG 2.1 AA in both
 * modes:
 * - `primaryForeground` on `primary` ≥ 4.5:1 (text on filled buttons), and
 * - `ring` (and, for the non-default presets, `primary`) against the page
 *   `background` and the `card` surface ≥ 3:1 (non-text UI / focus indicator).
 *
 * A preset is applied as `data-accent="<id>"` on `<html>`, set before first
 * paint by `accent-boot-script.ts` and kept in step by `AppearanceSync`.
 * `default` emits no CSS: it IS the brand tokens in `packages/ui/src/global.css`,
 * mirrored here only so they are contrast-checked too (the test compares them).
 */

export const ACCENT_IDS = ["default", "blue", "violet", "green", "orange", "rose", "teal"] as const;

export type AccentId = (typeof ACCENT_IDS)[number];

export type AccentModeTokens = {
    /** The page background the preset is checked against (not overridden). */
    background: string;
    /** The card / popover surface the preset is checked against (not overridden). */
    card: string;
    primary: string;
    primaryForeground: string;
    ring: string;
};

export type AccentPreset = {
    dark: AccentModeTokens;
    id: AccentId;
    light: AccentModeTokens;
};

/** Surfaces from `global.css` — `--brand-frost` / `--brand-white` (light), `--brand-charcoal` (dark). */
const LIGHT_SURFACES = { background: "#f2f2f2", card: "#ffffff" } as const;
const DARK_SURFACES = { background: "#212121", card: "#212121" } as const;

const WHITE = "#ffffff";
/** `--brand-obsidian`. */
const OBSIDIAN = "#191919";

/**
 * A filled accent: a deep (~700) shade under white text in light mode, a light
 * (~400) shade under obsidian text in dark mode; the focus ring is the accent.
 */
const accent = (id: AccentId, light: string, dark: string): AccentPreset => {
    return {
        dark: { ...DARK_SURFACES, primary: dark, primaryForeground: OBSIDIAN, ring: dark },
        id,
        light: { ...LIGHT_SURFACES, primary: light, primaryForeground: WHITE, ring: light },
    };
};

export const ACCENT_PRESETS: ReadonlyArray<AccentPreset> = [
    {
        // Mirrors `:root` / `.dark` in packages/ui/src/global.css — emits no CSS.
        dark: { ...DARK_SURFACES, primary: "#caff00", primaryForeground: OBSIDIAN, ring: "#8c8c8c" },
        id: "default",
        light: { ...LIGHT_SURFACES, primary: "#caff00", primaryForeground: OBSIDIAN, ring: "#636363" },
    },
    accent("blue", "#1d4ed8", "#60a5fa"),
    accent("violet", "#6d28d9", "#a78bfa"),
    accent("green", "#15803d", "#4ade80"),
    accent("orange", "#c2410c", "#fb923c"),
    accent("rose", "#be123c", "#fb7185"),
    accent("teal", "#0f766e", "#2dd4bf"),
];

export const DEFAULT_ACCENT: AccentId = "default";

const ACCENT_ID_SET: ReadonlySet<string> = new Set(ACCENT_IDS);

export const isAccentId = (value: unknown): value is AccentId => typeof value === "string" && ACCENT_ID_SET.has(value);

const declarations = (tokens: AccentModeTokens): string =>
    [
        `    --primary: ${tokens.primary};`,
        `    --primary-foreground: ${tokens.primaryForeground};`,
        `    --ring: ${tokens.ring};`,
        `    --sidebar-ring: ${tokens.ring};`,
    ].join("\n");

/**
 * The stylesheet for every non-default preset. `:root[data-accent]` (0,2,0)
 * beats global.css's `:root` / `.dark` (0,1,0); `:root.dark[data-accent]`
 * (0,3,0) beats the light rule. `next-themes` puts `.dark` on `<html>`.
 */
export const renderAccentCss = (): string => {
    const header = [
        "/*",
        " * GENERATED from src/features/appearance/lib/accent-presets.ts by renderAccentCss().",
        " * Do not edit by hand — change the TS module; accent-presets.test.ts prints the new output.",
        " */",
        // Unlayered on purpose: global.css's `:root` / `.dark` tokens are unlayered, and any layered rule loses to them.
        "/* eslint-disable css/use-layers */",
    ].join("\n");

    const rules = ACCENT_PRESETS.flatMap((preset) =>
        preset.id === DEFAULT_ACCENT
            ? []
            : [
                  `:root[data-accent="${preset.id}"] {\n${declarations(preset.light)}\n}`,
                  `:root.dark[data-accent="${preset.id}"] {\n${declarations(preset.dark)}\n}`,
              ],
    );

    return `${[header, ...rules].join("\n\n")}\n`;
};
