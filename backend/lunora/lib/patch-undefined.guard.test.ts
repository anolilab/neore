/**
 * No `ctx.db.patch` may be able to pass `undefined` as a field value.
 *
 * The runtime refuses it ("Cannot patch field 'x' to undefined") while the
 * patch type accepts it, so `tsc` is silent and the failure waits for the first
 * request that takes that branch — `updateTriggerStats` threw on every
 * successful trigger run this way. This test type-checks every patch call under
 * `lunora/` and fails on one whose second argument can carry `undefined`:
 *
 * - an object-literal property whose value's type includes `undefined`, or is
 *   `any`/`unknown` (a `v.any()` argument can arrive without a value);
 * - a spread, or a whole patch object, with an optional or `undefined`-typed
 *   property — unless it came from `withoutUndefined()` (`lib/patch.ts`), whose
 *   result is branded for exactly this check.
 *
 * Fix a finding with `patchRow` / `patchById` when `undefined` meant "remove
 * the field", or `withoutUndefined({...})` when it meant "leave it unchanged".
 * Not `null`: it writes, but a `v.optional` column then reads back as `null`
 * and fails every output validator that declares it.
 */
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = path.resolve(import.meta.dirname, "../..");
const BRAND = "__undefinedStripped";

/** `replace` runs the same undefined check as `patch`. */
const PATCHING_METHODS: ReadonlySet<string> = new Set(["patch", "replace"]);

/** A receiver named `db` or ending in `.db` — `ctx.db`, `context.db`. */
const DB_RECEIVER_RE = /\bdb$/u;

const includesUndefined = (type: ts.Type): boolean => {
    const undefinedLike = ts.TypeFlags.Undefined | ts.TypeFlags.Void;

    if (type.flags & undefinedLike) {
        return true;
    }

    return type.isUnion() && type.types.some((member) => (member.flags & undefinedLike) !== 0);
};

const findUnsafePatches = (): string[] => {
    const configPath = path.join(BACKEND_ROOT, "tsconfig.json");
    const config = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, BACKEND_ROOT);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const checker = program.getTypeChecker();
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
                PATCHING_METHODS.has(node.expression.name.text) &&
                DB_RECEIVER_RE.test(node.expression.expression.getText(sourceFile)) &&
                node.arguments.length >= 2
            ) {
                const argument = node.arguments[1]!;
                const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
                const where = `${path.relative(BACKEND_ROOT, file)}:${String(line + 1)}`;

                const checkObjectType = (spreadType: ts.Type, label: string): void => {
                    // A spread of `undefined`, `false` or `""` contributes nothing
                    // (`...(cond && { x })`, `...maybeDoc`): only its object members carry fields.
                    const members = spreadType.isUnion() ? spreadType.types : [spreadType];

                    for (const type of members) {
                        if (type.flags & ts.TypeFlags.Any) {
                            return;
                        }

                        if (!(type.flags & ts.TypeFlags.Object) || type.getProperty(BRAND)) {
                            continue;
                        }

                        for (const property of type.getProperties()) {
                            const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;

                            if (optional || includesUndefined(checker.getTypeOfSymbolAtLocation(property, argument))) {
                                findings.push(`${where} ${label}.${property.name}`);
                            }
                        }
                    }
                };

                if (ts.isObjectLiteralExpression(argument)) {
                    for (const property of argument.properties) {
                        if (ts.isSpreadAssignment(property)) {
                            checkObjectType(checker.getTypeAtLocation(property.expression), `...${property.expression.getText(sourceFile)}`);
                        } else if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
                            const value = ts.isPropertyAssignment(property) ? property.initializer : property.name;

                            const valueType = checker.getTypeAtLocation(value);

                            // `any` hides `undefined` — typically a `v.any()` argument, which can arrive without a value.
                            if (includesUndefined(valueType) || valueType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) {
                                findings.push(`${where} ${property.name.getText(sourceFile)}`);
                            }
                        }
                    }
                } else {
                    checkObjectType(checker.getTypeAtLocation(argument), argument.getText(sourceFile));
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    return findings;
};

describe("ctx.db.patch", () => {
    it("never receives a value that can be undefined", () => {
        expect(findUnsafePatches()).toStrictEqual([]);
    }, 120_000);
});
