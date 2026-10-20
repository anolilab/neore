import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { contrastRatio } from "./color-contrast";
import { effectiveContrast, isContrastId } from "./display-preferences";

/** LF-normalised. The path is a variable on purpose: Vite rewrites a literal `new URL("….css", import.meta.url)` into an asset import. */
const readRelative = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8").replaceAll("\r\n", "\n");

const CSS = readRelative("../contrast-presets.css");

const AAA_TEXT = 7;
const NON_TEXT = 4.5;

/** Declarations of the rule that starts with `selector`. */
const tokens = (selector: string): Record<string, string> => {
    const start = CSS.indexOf(`${selector} {`);
    const body = CSS.slice(start, CSS.indexOf("}", start));

    const declarations = body
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("--"))
        .map((line) => line.slice(0, -1).split(": ") as [string, string]);

    return Object.fromEntries(declarations);
};

const TEXT_PAIRS = [
    ["--foreground", "--background"],
    ["--card-foreground", "--card"],
    ["--popover-foreground", "--popover"],
    ["--muted-foreground", "--background"],
    ["--muted-foreground", "--muted"],
    ["--secondary-foreground", "--secondary"],
    ["--accent-foreground", "--accent"],
    ["--destructive", "--background"],
    ["--destructive-foreground", "--destructive"],
    ["--sidebar-foreground", "--sidebar"],
    ["--sidebar-accent-foreground", "--sidebar-accent"],
] as const;

const NON_TEXT_PAIRS = [
    ["--border", "--background"],
    ["--input", "--background"],
    ["--ring", "--background"],
    ["--sidebar-border", "--sidebar"],
    ["--sidebar-ring", "--sidebar"],
] as const;

describe.each([
    ["light", ':root[data-contrast="high"]'],
    ["dark", ':root.dark[data-contrast="high"]'],
])("high contrast tokens (%s)", (_mode, selector) => {
    const values = tokens(selector);

    it.each(TEXT_PAIRS)("%s on %s reaches 7:1", (foreground, background) => {
        expect(contrastRatio(values[foreground]!, values[background]!)).toBeGreaterThanOrEqual(AAA_TEXT);
    });

    it.each(NON_TEXT_PAIRS)("%s against %s reaches 4.5:1", (foreground, background) => {
        expect(contrastRatio(values[foreground]!, values[background]!)).toBeGreaterThanOrEqual(NON_TEXT);
    });
});

describe.each(["blue", "violet", "green", "orange", "rose", "teal"])("high contrast primary button (%s)", (accent) => {
    it("reaches 7:1 in light mode", () => {
        const values = tokens(`:root[data-contrast="high"][data-accent="${accent}"]`);

        expect(contrastRatio(values["--primary-foreground"]!, values["--primary"]!)).toBeGreaterThanOrEqual(AAA_TEXT);
    });

    it("reaches 7:1 in dark mode", () => {
        const values = tokens(`:root.dark[data-contrast="high"][data-accent="${accent}"]`);

        expect(contrastRatio(values["--primary-foreground"]!, values["--primary"]!)).toBeGreaterThanOrEqual(AAA_TEXT);
    });
});

describe.each([
    ["light", ':root[data-contrast="high"] #nd-docs-layout'],
    ["dark", ':root.dark[data-contrast="high"] #nd-docs-layout'],
])("high contrast documentation layout (%s)", (_mode, selector) => {
    const values = tokens(selector);

    it.each([
        ["--color-fd-foreground", "--color-fd-background"],
        ["--color-fd-muted-foreground", "--color-fd-background"],
        ["--color-fd-primary-foreground", "--color-fd-primary"],
    ])("%s on %s reaches 7:1", (foreground, background) => {
        expect(contrastRatio(values[foreground]!, values[background]!)).toBeGreaterThanOrEqual(AAA_TEXT);
    });
});

describe("contrast setting", () => {
    it("follows the system unless the user chose", () => {
        expect(effectiveContrast("system", true)).toBe("high");
        expect(effectiveContrast("system", false)).toBeUndefined();
        expect(effectiveContrast("standard", true)).toBeUndefined();
        expect(effectiveContrast("high", false)).toBe("high");
    });

    it("only accepts the known ids", () => {
        expect(isContrastId("high")).toBe(true);
        expect(isContrastId("low")).toBe(false);
        expect(isContrastId(undefined)).toBe(false);
    });
});

describe("dimmed theme colours", () => {
    it("are restored to the full token", () => {
        expect(CSS).toContain(String.raw`.text-muted-foreground\/50`);
        expect(CSS).toContain(String.raw`.border-border\/40`);
        expect(CSS).toContain(':not([class*=":text-"])');
        expect(CSS).toContain(':not([class*=":border-"])');
    });
});

describe("forced colours", () => {
    it("restores a visible keyboard focus where box-shadow rings are dropped", () => {
        expect(CSS).toContain("@media (forced-colors: active)");
        expect(CSS).toContain("outline: 2px solid Highlight");
    });

    it("restores the code editor's focus ring, which its own rule hides", () => {
        expect(CSS).toContain(".cm-editor.cm-focused:focus-within");
    });
});
