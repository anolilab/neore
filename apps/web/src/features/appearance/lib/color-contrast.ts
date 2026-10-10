/**
 * WCAG 2.1 contrast maths for the appearance presets.
 *
 * Accepts the two colour notations the theme tokens use: `#rgb` / `#rrggbb`
 * hex and `oklch(L C H)` (L as a number or a percentage, H in degrees; any
 * `/ alpha` part is ignored). Both are converted to LINEAR sRGB, from which
 * relative luminance is taken — https://www.w3.org/TR/WCAG21/#dfn-relative-luminance.
 */

type LinearRgb = readonly [number, number, number];

const HEX_PATTERN = /^#(?<hex>[\da-f]{3}|[\da-f]{6})$/i;
const OKLCH_PATTERN = /^oklch\((?<body>[^)]*)\)$/i;
const WHITESPACE = /\s+/;
const DEGREES_SUFFIX = /deg$/i;

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** The sRGB transfer function: gamma-encoded channel (0–1) → linear light. */
const srgbToLinear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);

const hexToLinear = (hex: string): LinearRgb => {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (offset: number): number => srgbToLinear(Number.parseInt(full.slice(offset, offset + 2), 16) / 255);

    return [channel(0), channel(2), channel(4)];
};

/** OKLCH → OKLab → linear sRGB (Björn Ottosson's reference matrices), clamped to the sRGB gamut. */
const oklchToLinear = (lightness: number, chroma: number, hueDegrees: number): LinearRgb => {
    const hue = (hueDegrees * Math.PI) / 180;
    const a = chroma * Math.cos(hue);
    const b = chroma * Math.sin(hue);

    const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
    const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
    const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;

    return [
        clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
        clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
        clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
    ];
};

/** Parses a hex or `oklch()` colour into linear sRGB. Throws on anything else. */
export const parseColor = (color: string): LinearRgb => {
    const trimmed = color.trim();
    const hex = HEX_PATTERN.exec(trimmed)?.groups?.hex;

    if (hex) {
        return hexToLinear(hex);
    }

    const body = OKLCH_PATTERN.exec(trimmed)?.groups?.body;

    if (body !== undefined) {
        // `L C H [/ alpha]` — alpha does not change the colour's luminance.
        const [lightness = "", chroma = "", hue = ""] = (body.split("/", 1)[0] ?? "").trim().split(WHITESPACE);
        const isPercent = lightness.endsWith("%");
        const values = [isPercent ? lightness.slice(0, -1) : lightness, chroma, hue.replace(DEGREES_SUFFIX, "")];

        if (values.every((value) => value !== "" && Number.isFinite(Number(value)))) {
            const [l, c, h] = values.map(Number) as [number, number, number];

            return oklchToLinear(isPercent ? l / 100 : l, c, h);
        }
    }

    throw new Error(`Unsupported colour notation: ${color}`);
};

/** WCAG relative luminance (0 = black, 1 = white). */
export const relativeLuminance = (color: string): number => {
    const [r, g, b] = parseColor(color);

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

/** WCAG contrast ratio between two colours, 1–21, order-independent. */
export const contrastRatio = (first: string, second: string): number => {
    const a = relativeLuminance(first);
    const b = relativeLuminance(second);

    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
