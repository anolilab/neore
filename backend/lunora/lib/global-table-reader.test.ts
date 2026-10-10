/**
 * `ctx.db.query("<table>")` must never name a `.global()` table.
 *
 * A `.global()` table is D1-backed and has no legacy `query()`/`withIndex()`
 * reader. `ctx.db.query("account").withIndex(...)` typechecks and then throws on
 * the first request — *"the legacy query()/withIndex() reader is not available
 * on the D1 (global) backend; use findMany"*. Global tables go through the ORM
 * facade instead: `ctx.db.account.findFirst({ where })`.
 *
 * This used to be enforced by rewriting `TypedTableQuery` in
 * `_generated/server.ts` after codegen, which made it a compile error. That was
 * strictly better feedback and the wrong place to put it: `_generated/**` is
 * written by a tool, and every regeneration threw the guard away silently — a
 * `lunora dev` watch did it on any source change. The protection was therefore
 * present exactly until someone ran the dev server.
 *
 * Reading the same rule out of `schema.ts` here costs the in-editor squiggle and
 * keeps everything else: it fails locally and in CI, it names the offending call
 * site, and adding `.global()` to a table still turns every existing reader on it
 * into a failure rather than a 500 in production.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const LUNORA_DIR = resolve(import.meta.dirname, "..");

const TABLE_DECLARATION_RE = /^ {4}(\w+): defineTable\(/gm;
const NEXT_TABLE_RE = /^ {4}\w+: defineTable\(/m;
const GLOBAL_CALL_RE = /\.global\(\)/;

/** Table names declared `.global()`, read from the schema rather than hardcoded. */
const globalTables = (): Set<string> => {
    const schema = readFileSync(join(LUNORA_DIR, "schema.ts"), "utf8");
    const found = new Set<string>();

    // `name: defineTable({ … }) … .global()` — match the table name that owns a
    // `.global()` call, allowing anything (indexes, comments) in between.
    for (const match of schema.matchAll(TABLE_DECLARATION_RE)) {
        const start = match.index;
        const nextTable = schema.slice(start + 1).search(NEXT_TABLE_RE);
        const block = schema.slice(start, nextTable === -1 ? undefined : start + 1 + nextTable);

        if (GLOBAL_CALL_RE.test(block)) {
            found.add(match[1] as string);
        }
    }

    return found;
};

const sourceFiles = (directory: string, accumulator: string[] = []): string[] => {
    for (const entry of readdirSync(directory)) {
        // Generated output is not ours to police, and node_modules is not ours at all.
        if (entry === "_generated" || entry === "node_modules") {
            continue;
        }

        const path = join(directory, entry);

        if (statSync(path).isDirectory()) {
            sourceFiles(path, accumulator);
        } else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) {
            accumulator.push(path);
        }
    }

    return accumulator;
};

describe("ctx.db.query()", () => {
    it("names no .global() table", () => {
        const globals = globalTables();

        expect(globals.size, "no .global() tables found — the schema parser has drifted").toBeGreaterThan(0);

        const offenders: string[] = [];

        for (const file of sourceFiles(LUNORA_DIR)) {
            // Comments are stripped first: `auth/admin.ts` explains this very rule
            // in prose, quoting the call it tells you not to make, and a naive
            // scan reports the documentation as the violation.
            const text = readFileSync(file, "utf8")
                .replaceAll(/\/\*[\s\S]*?\*\//g, (block) => block.replaceAll(/[^\n]/g, " "))
                .replaceAll(/\/\/[^\n]*/g, (line) => " ".repeat(line.length));

            for (const call of text.matchAll(/\.db\s*\.\s*query\(\s*["'](\w+)["']/g)) {
                const table = call[1] as string;

                if (globals.has(table)) {
                    const line = text.slice(0, call.index).split("\n").length;

                    offenders.push(
                        `${relative(LUNORA_DIR, file)}:${String(line)} — ctx.db.query("${table}") on a .global() table; use ctx.db.${table}.findFirst()/findMany()`,
                    );
                }
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});
