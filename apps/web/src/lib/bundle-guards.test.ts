/**
 * Static-import shapes that each put a large dependency on a startup path.
 * Every rule here was found on a real route and cost it the size quoted. A build
 * does not fail on any of them, so this is what notices a regression.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

const ROOTS = [
    join(import.meta.dirname, ".."),
    join(import.meta.dirname, "../../../../packages/ui/src"),
    join(import.meta.dirname, "../../../../packages/chat-ui/src"),
];

const SOURCE_FILE_RE = /\.tsx?$/;
const TEST_FILE_RE = /\.(?:test|spec)\.tsx?$/;
const LUCIDE_NAMESPACE_IMPORT_RE = /import \* as \w+ from "lucide-react"/;
const JSPDF_STATIC_IMPORT_RE = /^import [^;]*from "jspdf";/m;
const LOBEHUB_BARREL_VALUE_IMPORT_RE = /^import (?!type )[^;]*from "@lobehub\/icons";/m;
const ICON_MAP_STATIC_IMPORT_RE = /^import [^;]*from "[^"]*lucide-icon-map";/m;
/** The one module that may hold every lucide icon: it is only ever loaded with `import()` (`lucide-icon-loader.tsx`). */
const LUCIDE_ICON_MAP = "packages/ui/src/components/lucide-icon-map.tsx";

const listSources = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : listSources(path);
        }

        return SOURCE_FILE_RE.test(entry.name) && !TEST_FILE_RE.test(entry.name) ? [path] : [];
    });

const SOURCES = ROOTS.flatMap((root) => listSources(root)).map((path) => {
    return { path, text: readFileSync(path, "utf8") };
});

const offenders = (pattern: RegExp): string[] => {
    const repoRoot = join(import.meta.dirname, "../../../..");

    return SOURCES.filter(({ text }) => pattern.test(text)).map(({ path }) => relative(repoRoot, path));
};

describe("bundle guards", () => {
    it("never imports lucide-react as a namespace (keeps all ~1,600 icons), outside the lazily loaded icon map", () => {
        expect(offenders(LUCIDE_NAMESPACE_IMPORT_RE)).toStrictEqual([LUCIDE_ICON_MAP]);
    });

    it("never imports the icon map statically (it must stay its own lazy chunk)", () => {
        expect(offenders(ICON_MAP_STATIC_IMPORT_RE)).toStrictEqual([]);
    });

    it("never imports jspdf statically (~390KB; `await import` it)", () => {
        expect(offenders(JSPDF_STATIC_IMPORT_RE)).toStrictEqual([]);
    });

    it("never imports values from the @lobehub/icons barrel (every variant of every icon used)", () => {
        // A value import keeps each icon's compound object, i.e. all of its
        // variants. Import the variant file: `@lobehub/icons/es/<Name>/components/<Variant>`.
        expect(offenders(LOBEHUB_BARREL_VALUE_IMPORT_RE)).toStrictEqual([]);
    });
});
