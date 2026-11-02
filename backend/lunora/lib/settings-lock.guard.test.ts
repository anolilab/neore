/**
 * A signed-in user's preference write must pass the caller's active organization.
 *
 * `saveAiUserPreferences` / `saveUserSettings` hand their last argument to
 * `assertSettingsWritable`, which reads the organization's policy only when it
 * is not `null`. A user mutation that hardcodes `null` therefore skips the lock:
 * harmless while it writes no managed key, and a silent bypass the day the
 * managed list gains one. A user mutation passes the caller's active
 * organization instead, as in `ctx.user.activeOrganization?.id ?? null`.
 *
 * This test scans every call under `lunora/` and fails on a bare `null` literal
 * in that position unless the enclosing function is listed as a writer with no
 * organization (a job or a flow that has no `ctx.user`).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const LUNORA_ROOT = path.resolve(import.meta.dirname, "..");
const SAVERS: ReadonlySet<string> = new Set(["saveAiUserPreferences", "saveUserSettings"]);
const ORGANIZATION_ARGUMENT = 4;

/** Writers that run without a signed-in user, so they have no organization to pass. */
const WRITERS_WITHOUT_ORGANIZATION: ReadonlySet<string> = new Set(["consumeAsMcpHeader", "consumeAsProviderKey", "pruneExpiredToolPermissionGrants"]);

const isScanned = (file: string): boolean => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts");

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(full);
        }

        return isScanned(entry.name) ? [full] : [];
    });

/** The name of the nearest enclosing `const name = …` declaration. */
const enclosingName = (node: ts.Node): string => {
    for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
        if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
            return current.name.text;
        }
    }

    return "<module>";
};

const findNullOrganizationWrites = (): string[] => {
    const found: string[] = [];

    for (const file of sourceFiles(LUNORA_ROOT)) {
        const text = readFileSync(file, "utf8");

        if ([...SAVERS].every((name) => !text.includes(name))) {
            continue;
        }

        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && SAVERS.has(node.expression.text)) {
                const argument = node.arguments[ORGANIZATION_ARGUMENT];
                const owner = enclosingName(node);

                if (argument?.kind === ts.SyntaxKind.NullKeyword && !WRITERS_WITHOUT_ORGANIZATION.has(owner)) {
                    const { line } = source.getLineAndCharacterOfPosition(node.getStart());

                    found.push(`${path.relative(LUNORA_ROOT, file)}:${line + 1} ${owner}`);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(source);
    }

    return found;
};

describe("settings lock on signed-in writes", () => {
    it("passes the active organization from every user mutation", () => {
        expect(findNullOrganizationWrites()).toEqual([]);
    });
});
