/**
 * Padding/margin helpers, ported from `@react-email/button` and
 * `@react-email/text` (MIT, resend/react-email).
 *
 * See `./index.tsx` for why these live here rather than in node_modules.
 */

/* eslint-disable perfectionist/sort-objects -- the key order of these objects reaches the rendered
   `style` attribute; sorting them changes the emitted HTML. Pinned by `email-render.test.ts`. */
import type { CSSProperties } from "react";

/** `<number><unit>` with the units react-email understood. */
const LENGTH_PATTERN = /^([\d.]+)(px|em|rem|%)$/;
const WHITESPACE_PATTERN = /\s+/;

/** The four margin longhands `computeMargins` copies through untouched. */
const MARGIN_SIDES = ["marginTop", "marginRight", "marginBottom", "marginLeft"] as const;

/** Resolve a CSS length to pixels. `em`/`rem` assume 16px; `%` assumes a 600px email body. */
export const convertToPx = (value: number | string | undefined): number => {
    if (!value) {
        return 0;
    }

    if (typeof value === "number") {
        return value;
    }

    const matches = LENGTH_PATTERN.exec(value);

    if (matches && matches.length === 3) {
        const numberValue = Number.parseFloat(matches[1] as string);

        switch (matches[2]) {
            case "%": {
                return (numberValue / 100) * 600;
            }
            case "em":
            case "rem": {
                return numberValue * 16;
            }
            case "px": {
                return numberValue;
            }
            default: {
                return numberValue;
            }
        }
    }

    return 0;
};

/** Points from pixels, for the `mso-text-raise` Outlook hack. */
export const pxToPt = (px: number | undefined): number | undefined => (typeof px === "number" && !Number.isNaN(px) ? (px * 3) / 4 : undefined);

/**
 * Expand a 1-to-4 value CSS shorthand into its four sides.
 *
 * Returns an ORDERED list, not an object: the rendered `style` attribute prints
 * properties in insertion order, so preserving the upstream ordering is what
 * keeps the emitted HTML identical. The 1-value case really is top/bottom/
 * left/right while the others are top/right/bottom/left — that asymmetry is
 * upstream's, and reproducing it is the point.
 */
const expandShorthand = (side: "margin" | "padding", value: unknown): [string, unknown][] => {
    const k = (name: string) => `${side}${name}`;

    if (typeof value === "number") {
        return [
            [k("Top"), value],
            [k("Bottom"), value],
            [k("Left"), value],
            [k("Right"), value],
        ];
    }

    if (typeof value === "string") {
        const v = value.trim().split(WHITESPACE_PATTERN);

        if (v.length === 1) {
            return [
                [k("Top"), v[0]],
                [k("Bottom"), v[0]],
                [k("Left"), v[0]],
                [k("Right"), v[0]],
            ];
        }

        if (v.length === 2) {
            return [
                [k("Top"), v[0]],
                [k("Right"), v[1]],
                [k("Bottom"), v[0]],
                [k("Left"), v[1]],
            ];
        }

        if (v.length === 3) {
            return [
                [k("Top"), v[0]],
                [k("Right"), v[1]],
                [k("Bottom"), v[2]],
                [k("Left"), v[1]],
            ];
        }

        if (v.length === 4) {
            return [
                [k("Top"), v[0]],
                [k("Right"), v[1]],
                [k("Bottom"), v[2]],
                [k("Left"), v[3]],
            ];
        }
    }

    return [];
};

/** `Button`'s padding resolution: shorthand first, then explicit sides, all in px. */
export const parsePadding = (style: CSSProperties): { bottom?: number; left?: number; right?: number; top?: number } => {
    const raw: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(style)) {
        if (key === "padding") {
            for (const [k, v] of expandShorthand("padding", value)) {
                raw[k] = v;
            }
        } else if (key.startsWith("padding")) {
            raw[key] = value;
        }
    }

    const px = (v: unknown) => (v ? convertToPx(v as number | string) : undefined);

    return { bottom: px(raw["paddingBottom"]), left: px(raw["paddingLeft"]), right: px(raw["paddingRight"]), top: px(raw["paddingTop"]) };
};

/**
 * `Text`'s margin resolution, preserving upstream's key ORDER — the resulting
 * object is spread into `style`, so its ordering reaches the HTML.
 */
export const computeMargins = (style: CSSProperties): CSSProperties => {
    // Seeded in upstream's order so per-side assignments below land in these slots.
    let result: Record<string, unknown> = { marginTop: undefined, marginRight: undefined, marginBottom: undefined, marginLeft: undefined };

    for (const [key, value] of Object.entries(style)) {
        if (key === "margin") {
            result = Object.fromEntries(expandShorthand("margin", value));
        } else if ((MARGIN_SIDES as ReadonlyArray<string>).includes(key)) {
            result[key] = value;
        }
    }

    return result as CSSProperties;
};

/**
 * Every margin and padding longhand/shorthand `Body` neutralises on `<body>`.
 * Order is irrelevant here — it only decides which keys get zeroed.
 */
export const SPACING_PROPERTIES = [
    "margin",
    "marginTop",
    "marginBottom",
    "marginRight",
    "marginLeft",
    "marginInline",
    "marginBlock",
    "marginBlockStart",
    "marginBlockEnd",
    "marginInlineStart",
    "marginInlineEnd",
    "padding",
    "paddingTop",
    "paddingBottom",
    "paddingRight",
    "paddingLeft",
    "paddingInline",
    "paddingBlock",
    "paddingBlockStart",
    "paddingBlockEnd",
    "paddingInlineStart",
    "paddingInlineEnd",
] as const;
