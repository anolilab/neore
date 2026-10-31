/**
 * No generated procedure may register an EMPTY object as an argument.
 *
 * Codegen reads `.input()` only from object literals; a call such as
 * `v.object(partial(pick(…)))` or a bare const inside `v.object(...)` generates
 * `patch: {  }`, and the runtime then strips every key of that argument. The
 * harness validates with the SOURCE validators, so behavioural tests stay green.
 * This reads the generated files instead. It needs codegen to have run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const GENERATED = path.resolve(import.meta.dirname, "../_generated");
/**
 * Array-element shapes such as `Array<{  }>` are deliberately not matched: they appear for
 * `addMessages` and `_fetchSearchMessages`, which save correctly at runtime, so an empty
 * generated array element is a typing gap, not proven stripping.
 */
const EMPTY_PROPERTY = /\b\w+\??: \{\s*\}/;
const MIN_REFERENCES = 600;
const REFERENCE = /^\s*(\w+): FunctionReference<"\w+", /;

/** The first `{ ... }` of `text`, balanced, or `undefined` when it does not start with one. */
const leadingBraces = (text: string): string | undefined => {
    if (!text.startsWith("{")) {
        return undefined;
    }

    let depth = 0;

    for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "{") {
            depth += 1;
        } else if (text[index] === "}") {
            depth -= 1;

            if (depth === 0) {
                return text.slice(0, index + 1);
            }
        }
    }

    return undefined;
};

/** Matched reference lines per file: a codegen format change must not make the scan match nothing. */
const scanned: Record<string, number> = {};

const offenders = (file: string): string[] => {
    const found: string[] = [];

    scanned[file] = 0;

    const lines = readFileSync(path.join(GENERATED, file), "utf8").split("\n");

    for (const [index, line] of lines.entries()) {
        const match = REFERENCE.exec(line);

        if (!match) {
            continue;
        }

        scanned[file] += 1;

        const args = leadingBraces(line.slice(match[0].length));

        if (args && EMPTY_PROPERTY.test(args.slice(1, -1))) {
            found.push(`${file}:${index + 1} ${match[1]} -> ${EMPTY_PROPERTY.exec(args.slice(1, -1))?.[0]}`);
        }
    }

    return found;
};

describe("generated argument shapes", () => {
    it.each(["api.ts", "internal.ts"])("%s has no argument registered as an empty object", (file) => {
        expect(offenders(file), "arguments codegen could not read (use an object literal of inline validators)").toEqual([]);
    });

    it("scanned a sane number of references", () => {
        offenders("api.ts");
        offenders("internal.ts");

        expect((scanned["api.ts"] ?? 0) + (scanned["internal.ts"] ?? 0)).toBeGreaterThan(MIN_REFERENCES);
    });
});
