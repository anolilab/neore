/**
 * Photon operation catalog — declarative manifest of every editor action.
 *
 * Each entry describes how to invoke a function on the dynamically-loaded
 * `@silvia-odwyer/photon` module. Operations are categorized for grouping
 * in the editor UI.
 *
 * Two op kinds:
 * - "mutating": Photon mutates the PhotonImage in place. We keep using the
 *   same image after the call.
 * - "replacing": Photon returns a new PhotonImage (rotate, resize, crop).
 *   We must swap the image and free the old one.
 *
 * The function names below are kept aligned with `@silvia-odwyer/photon` 0.3.2;
 * the version is pinned in pnpm-workspace.yaml so this list stays valid.
 */

import type { Photon, PhotonImage } from "./photon-types";

export type ParameterSpec = {
    default: number;
    key: string;
    label: string;
    max: number;
    min: number;
    step: number;
};

export type OperationCategory = "transform" | "adjust" | "color" | "filter" | "effect" | "channel";

/**
 * Param accessor passed to `invoke`. Wrapping the dictionary in a getter
 * defeats `noUncheckedIndexedAccess` — the editor always populates every
 * key declared in `params` before calling, so a non-null assertion at the
 * call site is safe.
 */
export type ParameterGetter = (key: string) => number;

export type OperationDefinition = {
    category: OperationCategory;
    id: string;
    /** Build the Photon call. Use `p("key")` to read declared params. */
    invoke: (photon: Photon, image: PhotonImage, p: ParameterGetter) => PhotonImage | void;
    label: string;
    /** Optional sliders the user can drag before applying. */
    params?: ParameterSpec[];
    /** When true Photon returns a new PhotonImage that we must adopt. */
    replacing?: boolean;
};

export const makeParameterGetter =
    (bag: Record<string, number>): ParameterGetter =>
    (key) =>
        bag[key] ?? 0;

// Filter preset names recognised by photon.filter() in 0.3.2 — sourced from
// the JSDoc on the `filter` export. Names outside this list throw at runtime.
export const FILTER_PRESETS = [
    "oceanic",
    "islands",
    "marine",
    "seagreen",
    "flagblue",
    "liquid",
    "diamante",
    "radio",
    "twenties",
    "rosetint",
    "mauve",
    "bluechrome",
    "vintage",
    "perfume",
    "serenity",
] as const;

export type FilterPreset = (typeof FILTER_PRESETS)[number];

// Standalone effect functions (not routed through `filter()`). The `fn` key
// is constrained to the subset of Photon methods whose signature is exactly
// `(img: PhotonImage) => void` — guarantees we can't accidentally point at
// `rotate` (which returns a new PhotonImage that would leak) or at a function
// that takes extra args.
type ZeroArgumentFilterFunction = {
    [K in keyof Photon]-?: NonNullable<Photon[K]> extends (img: PhotonImage) => void ? K : never;
}[keyof Photon];

const STANDALONE_FILTERS: { fn: ZeroArgumentFilterFunction; id: string; label: string }[] = [
    { fn: "lofi", id: "filter-lofi", label: "Lofi" },
    { fn: "neue", id: "filter-neue", label: "Neue" },
    { fn: "lix", id: "filter-lix", label: "Lix" },
    { fn: "ryo", id: "filter-ryo", label: "Ryo" },
    { fn: "golden", id: "filter-golden", label: "Golden" },
    { fn: "pastel_pink", id: "filter-pastel-pink", label: "Pastel Pink" },
    { fn: "obsidian", id: "filter-obsidian", label: "Obsidian" },
    { fn: "cali", id: "filter-cali", label: "Cali" },
    { fn: "dramatic", id: "filter-dramatic", label: "Dramatic" },
    { fn: "firenze", id: "filter-firenze", label: "Firenze" },
    { fn: "duotone_violette", id: "filter-duotone-violette", label: "Duotone Violette" },
    { fn: "duotone_horizon", id: "filter-duotone-horizon", label: "Duotone Horizon" },
    { fn: "duotone_lilac", id: "filter-duotone-lilac", label: "Duotone Lilac" },
    { fn: "duotone_ochre", id: "filter-duotone-ochre", label: "Duotone Ochre" },
];

// ---------------------------------------------------------------------------
// Operation catalog
// ---------------------------------------------------------------------------

export const OPERATIONS: OperationDefinition[] = [
    // ----- Transform -----
    {
        category: "transform",
        id: "rotate-cw",
        invoke: (photon, img) => photon.rotate(img, 90),
        label: "Rotate 90° CW",
        replacing: true,
    },
    {
        category: "transform",
        id: "rotate-ccw",
        invoke: (photon, img) => photon.rotate(img, 270),
        label: "Rotate 90° CCW",
        replacing: true,
    },
    {
        category: "transform",
        id: "rotate-180",
        invoke: (photon, img) => photon.rotate(img, 180),
        label: "Rotate 180°",
        replacing: true,
    },
    {
        category: "transform",
        id: "flip-h",
        invoke: (photon, img) => photon.fliph(img),
        label: "Flip Horizontal",
    },
    {
        category: "transform",
        id: "flip-v",
        invoke: (photon, img) => photon.flipv(img),
        label: "Flip Vertical",
    },

    // ----- Adjust (sliders) -----
    {
        category: "adjust",
        id: "brightness",
        invoke: (photon, img, p) => photon.inc_brightness(img, Math.round(p("amount"))),
        label: "Brightness",
        params: [{ default: 20, key: "amount", label: "Amount", max: 100, min: -100, step: 1 }],
    },
    {
        category: "adjust",
        id: "contrast",
        invoke: (photon, img, p) => photon.adjust_contrast(img, p("amount")),
        label: "Contrast",
        params: [{ default: 30, key: "amount", label: "Amount", max: 100, min: -100, step: 1 }],
    },
    {
        category: "adjust",
        id: "hue-rotate",
        invoke: (photon, img, p) => photon.hue_rotate_hsl(img, p("degrees")),
        label: "Hue Rotate",
        params: [{ default: 60, key: "degrees", label: "Degrees", max: 360, min: 0, step: 1 }],
    },
    {
        category: "adjust",
        id: "saturate",
        invoke: (photon, img, p) => photon.saturate_hsl(img, p("level")),
        label: "Saturate",
        params: [{ default: 0.3, key: "level", label: "Level", max: 1, min: 0, step: 0.05 }],
    },
    {
        category: "adjust",
        id: "desaturate",
        invoke: (photon, img, p) => photon.desaturate_hsl(img, p("level")),
        label: "Desaturate",
        params: [{ default: 0.3, key: "level", label: "Level", max: 1, min: 0, step: 0.05 }],
    },
    {
        category: "adjust",
        id: "lighten",
        invoke: (photon, img, p) => photon.lighten_hsl(img, p("level")),
        label: "Lighten",
        params: [{ default: 0.2, key: "level", label: "Level", max: 1, min: 0, step: 0.05 }],
    },
    {
        category: "adjust",
        id: "darken",
        invoke: (photon, img, p) => photon.darken_hsl(img, p("level")),
        label: "Darken",
        params: [{ default: 0.2, key: "level", label: "Level", max: 1, min: 0, step: 0.05 }],
    },
    {
        category: "adjust",
        id: "gamma",
        invoke: (photon, img, p) => photon.gamma_correction(img, p("r"), p("g"), p("b")),
        label: "Gamma",
        params: [
            { default: 1, key: "r", label: "Red", max: 3, min: 0.1, step: 0.05 },
            { default: 1, key: "g", label: "Green", max: 3, min: 0.1, step: 0.05 },
            { default: 1, key: "b", label: "Blue", max: 3, min: 0.1, step: 0.05 },
        ],
    },

    // ----- Color -----
    {
        category: "color",
        id: "grayscale",
        invoke: (photon, img) => photon.grayscale(img),
        label: "Grayscale",
    },
    {
        category: "color",
        id: "grayscale-human",
        invoke: (photon, img) => photon.grayscale_human_corrected(img),
        label: "Grayscale (Human)",
    },
    {
        category: "color",
        id: "sepia",
        invoke: (photon, img) => photon.sepia(img),
        label: "Sepia",
    },
    {
        category: "color",
        id: "invert",
        invoke: (photon, img) => photon.invert(img),
        label: "Invert",
    },
    {
        category: "color",
        id: "primary",
        invoke: (photon, img) => photon.primary(img),
        label: "Primary",
    },
    {
        category: "color",
        id: "colorize",
        invoke: (photon, img) => photon.colorize(img),
        label: "Colorize",
    },
    {
        category: "color",
        id: "threshold",
        invoke: (photon, img, p) => photon.threshold(img, Math.round(p("level"))),
        label: "Threshold",
        params: [{ default: 128, key: "level", label: "Level", max: 255, min: 0, step: 1 }],
    },
    {
        category: "color",
        id: "horizontal-strips",
        invoke: (photon, img, p) => photon.horizontal_strips(img, Math.round(p("strips"))),
        label: "Horizontal Strips",
        params: [{ default: 8, key: "strips", label: "Strips", max: 32, min: 2, step: 1 }],
    },
    {
        category: "color",
        id: "vertical-strips",
        invoke: (photon, img, p) => photon.vertical_strips(img, Math.round(p("strips"))),
        label: "Vertical Strips",
        params: [{ default: 8, key: "strips", label: "Strips", max: 32, min: 2, step: 1 }],
    },

    // ----- Filter presets (via photon.filter()) -----
    ...FILTER_PRESETS.map<OperationDefinition>((preset) => {
        return {
            category: "filter",
            id: `filter-${preset}`,
            invoke: (photon, img) => photon.filter(img, preset),
            label: preset.replaceAll("_", " ").replaceAll(/\b\w/g, (c) => c.toUpperCase()),
        };
    }),

    // ----- Standalone filter functions -----
    ...STANDALONE_FILTERS.map<OperationDefinition>(({ fn, id, label }) => {
        return {
            category: "filter",
            id,
            invoke: (photon, img) => (photon[fn] as (i: PhotonImage) => void)(img),
            label,
        };
    }),

    // ----- Effects -----
    {
        category: "effect",
        id: "gaussian-blur",
        invoke: (photon, img, p) => photon.gaussian_blur(img, Math.round(p("radius"))),
        label: "Gaussian Blur",
        params: [{ default: 5, key: "radius", label: "Radius", max: 20, min: 1, step: 1 }],
    },
    {
        category: "effect",
        id: "box-blur",
        invoke: (photon, img) => photon.box_blur(img),
        label: "Box Blur",
    },
    {
        category: "effect",
        id: "sharpen",
        invoke: (photon, img) => photon.sharpen(img),
        label: "Sharpen",
    },
    {
        category: "effect",
        id: "edge-detection",
        invoke: (photon, img) => photon.edge_detection(img),
        label: "Edge Detection",
    },
    {
        category: "effect",
        id: "emboss",
        invoke: (photon, img) => photon.emboss(img),
        label: "Emboss",
    },
    {
        category: "effect",
        id: "noise-reduction",
        invoke: (photon, img) => photon.noise_reduction(img),
        label: "Noise Reduction",
    },
    {
        category: "effect",
        id: "oil",
        invoke: (photon, img, p) => photon.oil(img, Math.round(p("radius")), p("intensity")),
        label: "Oil Painting",
        params: [
            { default: 4, key: "radius", label: "Radius", max: 10, min: 1, step: 1 },
            { default: 55, key: "intensity", label: "Intensity", max: 100, min: 5, step: 1 },
        ],
    },
    {
        category: "effect",
        id: "frosted-glass",
        invoke: (photon, img) => photon.frosted_glass(img),
        label: "Frosted Glass",
    },
    {
        category: "effect",
        id: "solarize",
        invoke: (photon, img) => photon.solarize(img),
        label: "Solarize",
    },
    {
        category: "effect",
        id: "pixelize",
        invoke: (photon, img, p) => photon.pixelize(img, Math.round(p("size"))),
        label: "Pixelize",
        params: [{ default: 10, key: "size", label: "Pixel Size", max: 50, min: 2, step: 1 }],
    },
    {
        category: "effect",
        id: "dither",
        invoke: (photon, img, p) => photon.dither(img, Math.round(p("depth"))),
        label: "Dither",
        params: [{ default: 1, key: "depth", label: "Depth", max: 7, min: 1, step: 1 }],
    },
    {
        category: "effect",
        id: "normalize",
        invoke: (photon, img) => photon.normalize(img),
        label: "Normalize",
    },

    // ----- Channels -----
    {
        category: "channel",
        id: "alter-red",
        invoke: (photon, img, p) => photon.alter_red_channel(img, Math.round(p("amount"))),
        label: "Red Channel",
        params: [{ default: 40, key: "amount", label: "Amount", max: 255, min: -255, step: 1 }],
    },
    {
        category: "channel",
        id: "alter-green",
        invoke: (photon, img, p) => photon.alter_green_channel(img, Math.round(p("amount"))),
        label: "Green Channel",
        params: [{ default: 40, key: "amount", label: "Amount", max: 255, min: -255, step: 1 }],
    },
    {
        category: "channel",
        id: "alter-blue",
        invoke: (photon, img, p) => photon.alter_blue_channel(img, Math.round(p("amount"))),
        label: "Blue Channel",
        params: [{ default: 40, key: "amount", label: "Amount", max: 255, min: -255, step: 1 }],
    },
    {
        category: "channel",
        id: "swap-rg",
        invoke: (photon, img) => photon.swap_channels(img, 0, 1),
        label: "Swap R↔G",
    },
    {
        category: "channel",
        id: "swap-rb",
        invoke: (photon, img) => photon.swap_channels(img, 0, 2),
        label: "Swap R↔B",
    },
    {
        category: "channel",
        id: "swap-gb",
        invoke: (photon, img) => photon.swap_channels(img, 1, 2),
        label: "Swap G↔B",
    },
    {
        category: "channel",
        id: "offset-red",
        invoke: (photon, img, p) => photon.offset_red(img, Math.round(p("amount"))),
        label: "Offset Red",
        params: [{ default: 30, key: "amount", label: "Offset", max: 200, min: 1, step: 1 }],
    },
    {
        category: "channel",
        id: "offset-green",
        invoke: (photon, img, p) => photon.offset_green(img, Math.round(p("amount"))),
        label: "Offset Green",
        params: [{ default: 30, key: "amount", label: "Offset", max: 200, min: 1, step: 1 }],
    },
    {
        category: "channel",
        id: "offset-blue",
        invoke: (photon, img, p) => photon.offset_blue(img, Math.round(p("amount"))),
        label: "Offset Blue",
        params: [{ default: 30, key: "amount", label: "Offset", max: 200, min: 1, step: 1 }],
    },
];

export const OPERATIONS_BY_CATEGORY: Record<OperationCategory, OperationDefinition[]> = OPERATIONS.reduce(
    (accumulator, op) => {
        accumulator[op.category] ??= [];
        accumulator[op.category].push(op);

        return accumulator;
    },
    {} as Record<OperationCategory, OperationDefinition[]>,
);

export const CATEGORY_LABELS: Record<OperationCategory, string> = {
    adjust: "Adjust",
    channel: "Channels",
    color: "Color",
    effect: "Effects",
    filter: "Filters",
    transform: "Transform",
};
