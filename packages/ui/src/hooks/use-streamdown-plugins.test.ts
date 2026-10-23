import katex from "katex";
import { describe, expect, it } from "vitest";

import { loadHeavyStreamdownPlugins, needsHeavyStreamdownPlugins } from "./use-streamdown-plugins";

describe("mhchem formulas", () => {
    it(String.raw`routes inline \(...\) formulas to the heavy plugin set`, () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is \(\ce{H2O}\).`)).toBe(true);
    });

    it("keeps single-dollar text on the basic plugin set, since it is never math", () => {
        expect(needsHeavyStreamdownPlugins(String.raw`Water is $\ce{H2O}$ and it costs $20.`)).toBe(false);
    });

    it(String.raw`renders \ce and \pu once the heavy plugins have loaded`, async () => {
        await loadHeavyStreamdownPlugins();

        // Without the mhchem contrib, KaTeX throws "Undefined control sequence".
        const html = katex.renderToString(String.raw`\ce{CO2 + C -> 2 CO}`, { throwOnError: true });

        expect(html).toContain("CO");
        expect(() => katex.renderToString(String.raw`\pu{123 kJ/mol}`, { throwOnError: true })).not.toThrow();
    });
});
