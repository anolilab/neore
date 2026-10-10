import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AccentModeTokens } from "./accent-presets";
import { ACCENT_IDS, ACCENT_PRESETS, isAccentId, renderAccentCss } from "./accent-presets";
import { contrastRatio, relativeLuminance } from "./color-contrast";

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

const MODES = ["light", "dark"] as const;

const VAR_REFERENCE = /^var\((--[\w-]+)\)$/;

/** LF-normalised: a Windows checkout (core.autocrlf) turns the committed LF into CRLF, which changes no rule. */
const readRelative = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replaceAll("\r\n", "\n");

describe("color-contrast", () => {
    it("computes the WCAG reference ratios", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
        expect(contrastRatio("#fff", "#fff")).toBeCloseTo(1, 5);
        // WebAIM reference: #767676 on white is 4.54:1.
        expect(contrastRatio("#767676", "#ffffff")).toBeCloseTo(4.54, 2);
    });

    it("converts oklch to the same luminance as the equivalent hex", () => {
        expect(relativeLuminance("oklch(1 0 0)")).toBeCloseTo(1, 3);
        expect(relativeLuminance("oklch(0 0 0)")).toBeCloseTo(0, 5);
        // oklch(62.8% 0.2577 29.23) is sRGB red.
        expect(relativeLuminance("oklch(62.8% 0.2577 29.23)")).toBeCloseTo(relativeLuminance("#ff0000"), 2);
        // Gray: oklch(0.5 0 0) ≈ #636363.
        expect(relativeLuminance("oklch(0.5 0 0 / 50%)")).toBeCloseTo(relativeLuminance("#636363"), 2);
    });

    it("rejects notations it cannot evaluate", () => {
        expect(() => relativeLuminance("var(--primary)")).toThrow("Unsupported colour notation");
    });
});

describe("accent presets", () => {
    it("has exactly one preset per id", () => {
        expect(ACCENT_PRESETS.map((preset) => preset.id)).toStrictEqual([...ACCENT_IDS]);
        expect(isAccentId("blue")).toBe(true);
        expect(isAccentId("magenta")).toBe(false);
        expect(isAccentId(undefined)).toBe(false);
    });

    describe.each(ACCENT_PRESETS.flatMap((preset) => MODES.map((mode) => [`${preset.id} (${mode})`, preset.id, preset[mode]] as const)))(
        "%s",
        (_name, id, tokens: AccentModeTokens) => {
            it(`primary-foreground on primary is ≥ ${AA_TEXT}:1`, () => {
                expect(contrastRatio(tokens.primaryForeground, tokens.primary)).toBeGreaterThanOrEqual(AA_TEXT);
            });

            it(`focus ring is ≥ ${AA_NON_TEXT}:1 against the background and the card surface`, () => {
                expect(contrastRatio(tokens.ring, tokens.background)).toBeGreaterThanOrEqual(AA_NON_TEXT);
                expect(contrastRatio(tokens.ring, tokens.card)).toBeGreaterThanOrEqual(AA_NON_TEXT);
            });

            // The brand lime is a fill, never a boundary, so only the chosen
            // accents are held to the non-text rule for `primary` itself.
            it.skipIf(id === "default")(`accent is ≥ ${AA_NON_TEXT}:1 against the background and the card surface`, () => {
                expect(contrastRatio(tokens.primary, tokens.background)).toBeGreaterThanOrEqual(AA_NON_TEXT);
                expect(contrastRatio(tokens.primary, tokens.card)).toBeGreaterThanOrEqual(AA_NON_TEXT);
            });
        },
    );

    it("accent-presets.css is the output of renderAccentCss()", () => {
        // On failure, regenerate: write `renderAccentCss()` to src/features/appearance/accent-presets.css.
        expect(readRelative("../accent-presets.css")).toBe(renderAccentCss());
    });

    it("the default preset mirrors the brand tokens in packages/ui/src/global.css", () => {
        const css = readRelative("../../../../../../packages/ui/src/global.css");

        const block = (selector: string): Map<string, string> => {
            const start = css.indexOf(`${selector} {`);

            expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);

            const body = css.slice(start, css.indexOf("\n}", start));

            // `--name: value;` declarations; a trailing `/* comment */` lands before the next line break.
            const entries = body
                .split(";")
                .map((piece) => piece.slice(piece.lastIndexOf("\n") + 1).trim())
                .filter((declaration) => declaration.startsWith("--"))
                .map((declaration): [string, string] => {
                    const colon = declaration.indexOf(":");

                    return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
                });

            return new Map(entries);
        };

        const root = block(":root");
        const dark = block(".dark");
        const resolve = (value: string | undefined): string | undefined => {
            const reference = VAR_REFERENCE.exec(value ?? "")?.[1];

            return reference ? root.get(reference) : value;
        };
        const tokensOf = (variables: Map<string, string>) => {
            return {
                background: resolve(variables.get("--background")),
                card: resolve(variables.get("--card")),
                primary: resolve(variables.get("--primary")),
                primaryForeground: resolve(variables.get("--primary-foreground")),
                ring: resolve(variables.get("--ring")),
            };
        };

        const defaultPreset = ACCENT_PRESETS.find((preset) => preset.id === "default");

        expect(tokensOf(root)).toStrictEqual(defaultPreset?.light);
        expect(tokensOf(dark)).toStrictEqual(defaultPreset?.dark);
    });
});
