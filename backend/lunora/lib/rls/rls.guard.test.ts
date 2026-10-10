/**
 * Keeps row-level security wired and its bypasses reviewed.
 *
 * - Every client-reachable query and mutation carries the `rls()` step (the
 *   builder hoists it as `fn.rls`). A procedure built on a builder that lost it
 *   would run with no policies at all, silently.
 * - Every schema table either has policies or is listed, with its reason, as
 *   deliberately unpoliced — so a new table is a decision, not a default.
 * - `systemDb` / `parentKeyOf` / `readerForAdmittedThread` (reads past RLS) are imported only by the files
 *   below. Each is an access DECISION; a new importer is a review.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import schema from "../../schema";
import { POLICY_TABLES, UNPOLICED_TABLES } from "./policies";
import { ADMITTED_THREAD_INDEXES } from "./scope";

const byName = (a: string, b: string): number => a.localeCompare(b);
const IMPORTS_BYPASS = /import \{[^}]*\b(?:parentKeyOf|readerForAdmittedThread|systemDb)\b[^}]*\} from "[./]+(?:lib\/)?rls\/scope"/u;
const NEXT_TOP_LEVEL = /\n(?![\s.)\]}])/u;
const READS_DB = /\b(?:ctx|context)\.db\b/u;

const LUNORA = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SYSTEM_DB_IMPORTERS = [
    // Access decisions (they then ADMIT what they decided).
    "agent/thread-read-access.ts",
    "pages/access.ts",
    // Bearer tokens: the token is the capability.
    "chat/sharing.ts",
    "pages/sharing.ts",
    // Child row by id → its parent's key → decide on the parent.
    "chat/streaming/index.ts",
    "memory/functions.ts",
    "pages/comments.ts",
    "pages/functions.ts",
    // Existence, uniqueness and storage-ownership decisions about another user.
    "agent/display-media.ts",
    "chat/functions.ts",
    "lib/stored-url-fields.ts",
    "skills/validators.ts",
    "vault/functions.ts",
    // An ADMITTED thread's rows on the hot read paths (`readerForAdmittedThread`).
    "agent/admitted-thread-db.ts",
    // `count()` of the caller's own rows, which cannot run behind a read policy.
    "agent/threads.ts",
    "gdpr/functions.ts",
    "skills/functions.ts",
    "skills/marketplace.ts",
].toSorted(byName);

/** `relative()` with POSIX separators, so the keys below hold on Windows too. */
const fromLunora = (file: string): string => relative(LUNORA, file).split(sep).join("/");

const sourceFiles = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "_generated" || entry.name === "node_modules" ? [] : sourceFiles(path);
        }

        return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
    });

describe("row-level security wiring", () => {
    it("guards every client-reachable query and mutation", async () => {
        const { LUNORA_FUNCTIONS } = await import("../../_generated/functions");
        const reachable = Object.entries(LUNORA_FUNCTIONS).filter(
            ([, function_]) =>
                function_.visibility !== "internal" && (function_.kind === "query" || function_.kind === "mutation") && function_.lifecycle === undefined,
        );
        const unguarded = reachable.filter(([, function_]) => !(function_ as { rls?: unknown }).rls).map(([path]) => path);

        // Sanity: an empty registry would make this vacuous.
        expect(reachable.length).toBeGreaterThan(300);
        expect(unguarded, "Build client-reachable procedures on a guarded builder from lib/crpc.ts").toEqual([]);
    }, 60_000);

    it("decides every schema table: policies, or a listed reason for none", () => {
        const tables = Object.keys((schema as unknown as { tables: Record<string, unknown> }).tables).toSorted(byName);
        const decided = new Set([...POLICY_TABLES, ...Object.keys(UNPOLICED_TABLES)]);
        const both = POLICY_TABLES.filter((table) => table in UNPOLICED_TABLES);

        expect(both, "a table is either policed or listed as unpoliced, not both").toEqual([]);
        expect(
            tables.filter((table) => !decided.has(table)),
            "add policies in lib/rls/policies.ts, or list the table in UNPOLICED_TABLES with the reason",
        ).toEqual([]);
        expect([...decided].filter((table) => !tables.includes(table)).toSorted(byName), "stale entries").toEqual([]);
    });

    it("reads past row-level security only where it was reviewed", () => {
        const importers = sourceFiles(LUNORA)
            .filter((file) => !file.includes(join("lib", "rls")))
            .filter((file) => IMPORTS_BYPASS.test(readFileSync(file, "utf8")))
            .map((file) => fromLunora(file))
            .toSorted(byName);

        expect(importers, "systemDb/parentKeyOf bypass row-level security: review the use, then list the file").toEqual(SYSTEM_DB_IMPORTERS);
    });

    it("no action reads ctx.db directly (actions are not guarded; they reach data through runQuery/runMutation)", () => {
        const offenders: string[] = [];

        for (const file of sourceFiles(LUNORA)) {
            const source = readFileSync(file, "utf8");

            for (const match of source.matchAll(/^export const (\w+) = (?:action|publicAction|authAction|adminAction)\b/gmu)) {
                const start = match.index;
                // The builder chain ends at the next top-level statement.
                const next = NEXT_TOP_LEVEL.exec(source.slice(start + 1));
                const body = source.slice(start, next ? start + 1 + next.index : undefined);

                if (READS_DB.test(body)) {
                    offenders.push(`${fromLunora(file)}:${match[1] as string}`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it("lets readerForAdmittedThread in only through indexes that start with threadId", () => {
        const source = readFileSync(join(LUNORA, "schema.ts"), "utf8");
        const wrong: string[] = [];

        for (const [table, indexes] of Object.entries(ADMITTED_THREAD_INDEXES)) {
            for (const index of indexes) {
                const fields = new RegExp(String.raw`\.index\("${index}", \[\s*"(\w+)"`, "u").exec(source)?.[1];

                if (fields !== "threadId") {
                    wrong.push(`${table}.${index} (first field: ${fields ?? "not found"})`);
                }
            }
        }

        expect(wrong).toEqual([]);
    });
});
