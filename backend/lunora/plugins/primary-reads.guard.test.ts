import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `pluginInstalls` and `pluginItems` are global D1 tables: a replica read can miss a takeover's new generation, so a read that
 * decides or fences a write must go to the primary. Every plugin read of them names `consistency: "primary"`.
 */
describe("plugin table reads", () => {
    it("all use the primary", () => {
        const directory = import.meta.dirname;
        const offenders: string[] = [];

        const files = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

        for (const file of files) {
            const source = readFileSync(join(directory, file), "utf8");

            for (const match of source.matchAll(/\.(?:pluginInstalls|pluginItems)\.find(?:First|Many)\(\{([^}]*)\}/gu)) {
                if (!match[1]?.includes('consistency: "primary"')) {
                    offenders.push(`${file}: ${match[0].slice(0, 60)}`);
                }
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});
