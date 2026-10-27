/**
 * The built `@neore/ai/capabilities` subpath must import nothing outside itself:
 * the desktop main process and the mobile app read it without the model SDKs.
 * Reads `dist/`, so it needs `pnpm build:packages` first, as CI does.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DIST = path.join(PACKAGE_ROOT, "dist");
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

/** The built entry of every other subpath, read from `package.json#exports` so a new one is covered. */
const otherEntries = (): string[] => {
    const { exports } = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8")) as { exports: Record<string, string | { default?: string }> };

    return Object.entries(exports)
        .filter(([subpath]) => subpath !== "./capabilities" && subpath !== "./package.json")
        .map(([, target]) => path.resolve(PACKAGE_ROOT, typeof target === "string" ? target : (target.default ?? "")));
};

describe("@neore/ai/capabilities (built)", () => {
    const entry = path.join(DIST, "capabilities/index.js");

    it("is built", () => {
        expect(existsSync(entry), "run `pnpm build:packages` before this test").toBe(true);
    });

    it("reads its own bundler chunks, so the checks below see something", () => {
        expect(closureOf(entry).files.size).toBeGreaterThan(1);
    });

    it("imports only relative files, and its types import nothing", () => {
        expect(closureOf(entry).specifiers.filter((specifier) => !specifier.startsWith("."))).toEqual([]);
        expect(specifiersOf(path.join(DIST, "capabilities/index.d.ts"))).toEqual([]);
    });

    it("shares no bundler chunk with another subpath", () => {
        // A chunk another entry also uses would drag that entry's dependencies in.
        const { files } = closureOf(entry);
        const entries = otherEntries();

        expect(entries.length).toBeGreaterThan(5);

        for (const other of entries) {
            const reached = closureOf(other).files;

            expect([...files].filter((file) => file !== entry && reached.has(file))).toEqual([]);
        }
    });
});
