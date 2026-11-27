import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const STRING = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60`;

/** The source with comments blanked, so a comment cannot satisfy a check. Strings are matched first, so a `//` inside one stays. */
const COMMENT_OR_STRING = new RegExp(String.raw`${STRING}|//[^\n]*|/\*[\s\S]*?\*/`, "gu");
const TOKEN = new RegExp(String.raw`${STRING}|[\s\S]`, "gu");
const PRIMARY = /(?:^|[,{\s])consistency\s*:\s*"primary"/u;

const withoutComments = (source: string): string =>
    source.replaceAll(COMMENT_OR_STRING, (token) => (token.startsWith("//") || token.startsWith("/*") ? "" : token));

/** The text of the object argument that opens at `open` (a `{`), with everything nested deeper than its own keys dropped. */
const topLevelOf = (source: string, open: number): string => {
    let depth = 0;
    let top = "";

    const tokens = source.slice(open).matchAll(TOKEN);

    for (const [token] of tokens) {
        if ("({[".includes(token)) {
            depth += 1;
        } else if (")}]".includes(token)) {
            depth -= 1;

            if (depth === 0) {
                break;
            }
        } else if (depth === 1) {
            top += token;
        }
    }

    return top;
};

/** The reads of `tables` in `source` whose argument object has no top-level `consistency: "primary"`, in any property order. */
const readsWithoutPrimary = (file: string, source: string, tables: string): string[] => {
    const code = withoutComments(source);
    const offenders: string[] = [];

    const reads = code.matchAll(new RegExp(String.raw`\.(?:${tables})\.find(?:First|Many)\(\{`, "gu"));

    for (const match of reads) {
        const open = match.index + match[0].length - 1;

        if (!PRIMARY.test(topLevelOf(code, open))) {
            offenders.push(`${file}: ${match[0].slice(0, 60)}`);
        }
    }

    return offenders;
};

/**
 * `pluginInstalls` and `pluginItems` are global D1 tables: a replica read can miss a takeover's new generation, so a read that
 * decides or fences a write must go to the primary. Every plugin read of them names `consistency: "primary"`.
 */
/**
 * Files whose `skills` reads still use the default consistency and are owned by other work in flight; each decides a write from a
 * marker or id lookup, and is to move to the primary. Nothing is added to this list.
 */
describe("plugin table reads", () => {
    it("all use the primary", () => {
        const directory = import.meta.dirname;
        const offenders: string[] = [];

        const files = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

        for (const file of files) {
            const source = readFileSync(join(directory, file), "utf8");

            offenders.push(...readsWithoutPrimary(file, source, "pluginInstalls|pluginItems"));
        }

        expect(offenders).toStrictEqual([]);
    });

    it("read the skills a sweep decides on from the primary", () => {
        const directory = import.meta.dirname;
        const offenders: string[] = [];

        const files = readdirSync(directory).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));

        for (const file of files) {
            const source = readFileSync(join(directory, file), "utf8");

            offenders.push(...readsWithoutPrimary(file, source, "skills"));
        }

        expect(offenders).toStrictEqual([]);
    });

    it("reads consistency from the top level of the argument, in any property order, and ignores comments", () => {
        const check = (code: string) => readsWithoutPrimary("x.ts", code, "skills");

        expect(check('ctx.db.skills.findFirst({ consistency: "primary", where: { a: 1 } })')).toStrictEqual([]);
        expect(check('ctx.db.skills.findFirst({ where: { a: { b: 1 } }, consistency: "primary" })')).toStrictEqual([]);
        expect(check('ctx.db.skills.findFirst({ where: { a: 1 } }) // consistency: "primary"')).toHaveLength(1);
        expect(check('ctx.db.skills.findFirst({ where: { consistency: "primary" } })')).toHaveLength(1);
    });
});
