/**
 * The built `@neore/ai/capabilities` subpath must import nothing outside itself:
 * the desktop main process and the mobile app read it without the model SDKs.
 * Reads `dist/`, so it needs `pnpm build:packages` first, as CI does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const DIST = fileURLToPath(new URL("../../dist", import.meta.url));
const FROM_RE = /\bfrom\s*["']([^"']+)["']/gu;
const BARE_IMPORT_RE = /\bimport\s*\(?["']([^"']+)["']/gu;

const specifiersOf = (file: string): string[] => {
    const source = readFileSync(file, "utf8");

    return [...source.matchAll(FROM_RE), ...source.matchAll(BARE_IMPORT_RE)].map((match) => match[1] ?? "");
};

/** Every file reachable from `entry` through imports, and every specifier met on the way. */
const closureOf = (entry: string): { files: Set<string>; specifiers: string[] } => {
    const files = new Set<string>();
    const specifiers: string[] = [];
    const queue = [entry];

    for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
        if (files.has(file)) {
            continue;
        }

        files.add(file);

        for (const specifier of specifiersOf(file)) {
            specifiers.push(specifier);

            if (specifier.startsWith(".")) {
                queue.push(path.resolve(path.dirname(file), specifier));
            }
        }
    }

    return { files, specifiers };
};

describe("@neore/ai/capabilities (built)", () => {
    const entry = path.join(DIST, "capabilities/index.js");

    it("is built", () => {
        expect(existsSync(entry), "run `pnpm build:packages` before this test").toBe(true);
    });

    it("imports only relative files, none of the package's other code", () => {
        const { files, specifiers } = closureOf(entry);

        expect(specifiers.filter((specifier) => !specifier.startsWith("."))).toEqual([]);

        // The bundler puts code in shared chunks; the closure must not reach a chunk that
        // another entry also uses, or the subpath drags that entry's dependencies along.
        const others = [
            "index.js",
            "models/index.js",
            "providers/index.js",
            "tools/index.js",
            "prompts/index.js",
            "design/index.js",
            "utils/index.js",
            "gateway.js",
            "constants.js",
        ];

        for (const other of others) {
            const reached = closureOf(path.join(DIST, other)).files;

            expect([...files].filter((file) => file !== entry && reached.has(file))).toEqual([]);
        }
    });
});
