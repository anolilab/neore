import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { Options } from "../src/index";
import TurndownService from "../src/index";

interface GoldenCase {
    expected: string;
    input: string;
    name: string;
    options: Partial<Options>;
}

// Cases ported from upstream turndown's test/index.html (MIT, Dom Christie).
const cases: GoldenCase[] = JSON.parse(readFileSync(new URL("fixtures/upstream-cases.json", import.meta.url), "utf8"));

describe("upstream golden cases", () => {
    for (const { expected, input, name, options } of cases) {
        it(name, () => {
            expect(new TurndownService(options).turndown(input)).toBe(expected);
        });
    }
});
