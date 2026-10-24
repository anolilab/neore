import katex from "katex";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Streamdown } from "streamdown";
import { describe, expect, it } from "vitest";

import { loadHeavyStreamdownPlugins, needsHeavyStreamdownPlugins } from "./use-streamdown-plugins";

describe("mhchem formulas", () => {
    it(String.raw`routes inline \(...\) formulas to the heavy plugin set`, () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is \(\ce{H2O}\).`)).toBe(true);
    });

    it("routes a balanced single-dollar formula to the heavy plugin set", () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is $\ce{H2O}$ and it costs $20.`)).toBe(true);
        expect(needsHeavyStreamdownPlugins("let $x^2$ be positive")).toBe(true);
    });

    it("keeps a lone currency marker on the basic plugin set, since it has no formula", () => {
        expect(needsHeavyStreamdownPlugins("it costs $20.")).toBe(false);
    });

    it("renders single-dollar formulas with the loaded plugin set", async () => {
        const plugins = await loadHeavyStreamdownPlugins();
        const html = renderToStaticMarkup(createElement(Streamdown, { plugins }, "let $x^2$ be positive"));

        expect(html).toContain('class="katex"');
    });

    it("leaves a lone currency marker unrendered as math with the loaded plugins, even mid-stream", async () => {
        const plugins = await loadHeavyStreamdownPlugins();

        for (const text of ["it costs $20.", "it costs $20"]) {
            const html = renderToStaticMarkup(createElement(Streamdown, { plugins }, text));

            expect(html).not.toContain('class="katex"');
            expect(html).toContain("$20");
        }
    });

    it(String.raw`renders \ce and \pu once the heavy plugins have loaded`, async () => {
        await loadHeavyStreamdownPlugins();

        // Without the mhchem contrib, KaTeX throws "Undefined control sequence".
        const html = katex.renderToString(String.raw`\ce{CO2 + C -> 2 CO}`, { throwOnError: true });

        expect(html).toContain("CO");
        expect(() => katex.renderToString(String.raw`\pu{123 kJ/mol}`, { throwOnError: true })).not.toThrow();
    });
});
