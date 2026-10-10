/**
 * No `get` by id of a `.global()` row.
 *
 * A `get` of a `.global()` id is not routed to its table: the shard does not
 * find the id among its own tables and probes EVERY global table in one
 * batched D1 round trip (41 tables, ~70-125ms locally). Neither
 * `ctx.db.asId(table, id)` nor the facade's own `ctx.db.<table>.get(id)`
 * avoids it — measured 2026-09-25, when the one in `getAuthUserIdentity` cost
 * every authenticated call ~0.3-0.5s. `ctx.db.<table>.findFirst({ where: { _id } })`
 * is one statement.
 *
 * This test type-checks every `get(...)` on a database receiver (`ctx.db`,
 * `ctx.db.<table>`, `systemDb(ctx)`) under `lunora/` and fails on one whose
 * argument is typed as the id of a `.global()` table. An argument typed as a
 * plain `string` is not caught — type it, or read through `findFirst`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");
const ID_TYPE_RE = /^Id<"(\w+)">$/u;
const BRANDED_ID_RE = /__tableName: "(\w+)"/u;

/** Tables declared `.global()` in `schema.ts`, read from its source. */
const globalTables = (): Set<string> => {
    const source = readFileSync(path.join(BACKEND_ROOT, "lunora/schema.ts"), "utf8");
    const starts = [...source.matchAll(/\n {4}(\w+): defineTable\(/gu)];
    const tables = new Set<string>();

    for (const [index, match] of starts.entries()) {
        const end = starts[index + 1]?.index ?? source.length;

        if (source.slice(match.index, end).includes(".global()")) {
            tables.add(match[1] as string);
        }
    }

    return tables;
};

/** `ctx.db`, `context.db`, `ctx.db.<table>`, or a `systemDb(ctx)` call. */
const isDatabaseReceiver = (node: ts.Expression): boolean => {
    if (ts.isCallExpression(node)) {
        return ts.isIdentifier(node.expression) && node.expression.text === "systemDb";
    }

    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
        return isDatabaseReceiver(node.expression);
    }

    if (!ts.isPropertyAccessExpression(node)) {
        return false;
    }

    // `…db` itself, or `…db.<table>`.
    return node.name.text === "db" || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "db");
};

/** The table an `Id<"t">` names, if the type is one. */
const idTableOf = (type: ts.Type, checker: ts.TypeChecker): string[] => {
    const types = type.isUnion() ? type.types : [type];
    const tables: string[] = [];

    for (const member of types) {
        const text = checker.typeToString(member);
        const match = ID_TYPE_RE.exec(text) ?? BRANDED_ID_RE.exec(text);

        if (match) {
            tables.push(match[1] as string);
        }
    }

    return tables;
};

const findGlobalGets = (): string[] => {
    const configPath = path.join(BACKEND_ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, BACKEND_ROOT);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
    const tables = globalTables();
    const findings: string[] = [];

    for (const sourceFile of program.getSourceFiles()) {
        const file = sourceFile.fileName;

        if (!file.includes("/lunora/") || file.includes("/_generated/") || file.endsWith(".test.ts") || file.endsWith(".d.ts")) {
            continue;
        }

        const visit = (node: ts.Node): void => {
            if (
                ts.isCallExpression(node) &&
                ts.isPropertyAccessExpression(node.expression) &&
                node.expression.name.text === "get" &&
                isDatabaseReceiver(node.expression.expression) &&
                node.arguments.length > 0
            ) {
                const argument = node.arguments.at(-1) as ts.Expression;
                const hit = idTableOf(checker.getTypeAtLocation(argument), checker).find((table) => tables.has(table));

                if (hit) {
                    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());

                    findings.push(`${path.relative(BACKEND_ROOT, file)}:${String(line + 1)} get of a .global() "${hit}" id`);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return findings;
};

describe("global-table gets", () => {
    it("reads .global() rows by id through findFirst, never get", () => {
        expect(globalTables().has("user")).toBe(true);
        expect(findGlobalGets()).toEqual([]);
    }, 300_000);
});
