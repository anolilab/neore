/**
 * `AUDIT_TABLES` and `schema.ts` are two hand-maintained halves of one thing.
 *
 * The list here names which tables write an audit row and which column
 * attributes it; `schema.ts` names each table a second time,
 * `.triggers((t) => auditTriggersFor(t, "<table>", AUDIT_TABLES["<table>"]!))`,
 * 19 times. The generator that used to emit those lines from the list is
 * deleted, so nothing keeps them in step.
 *
 * Every way they can drift fails SILENTLY, which is why this is a test and not a
 * comment:
 *
 *  - An entry added here with no `.triggers(...)` line is simply not audited.
 *    Nothing errors; the rows just never appear, and GDPR's
 *    `listUserActivity` under-reports forever.
 *  - The two names inside one call can disagree —
 *    `auditTriggersFor(t, "team", AUDIT_TABLES["teamMember"]!)` typechecks and
 *    attributes team rows by the wrong column.
 *  - The call can be chained onto a different table than the one it names, which
 *    is the same bug one level out.
 *  - An accessor can read a column `schema.ts` no longer declares. `asString`
 *    turns the resulting `undefined` into an empty attribution rather than
 *    throwing, so the audit row is written and simply belongs to nobody.
 *
 * Parsing the source rather than importing the schema is deliberate: the
 * question is what `schema.ts` *says*, and the builder does not expose its
 * triggers for inspection afterwards.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { AUDIT_TABLES, auditTriggersFor } from "./audit-triggers";

const LUNORA_DIR = resolve(import.meta.dirname, "..");
const schemaSource = readFileSync(join(LUNORA_DIR, "schema.ts"), "utf8");

/** `    name: defineTable(` — the four-space indent is what makes it top level. */
const TABLE_DECLARATION_RE = /^ {4}(\w+): defineTable\(/gm;
const NEXT_TABLE_RE = /^ {4}\w+: defineTable\(/m;
const AUDIT_CALL_RE = /auditTriggersFor\(\s*t\s*,\s*"(\w+)"\s*,\s*AUDIT_TABLES\["(\w+)"\]/g;
/** `        column: v.something(` inside a table block. */
const COLUMN_RE = /^ {8}(\w+): v\./gm;

/** Each top-level table's source block, keyed by table name. */
const tableBlocks = (): Map<string, string> => {
    const blocks = new Map<string, string>();

    for (const match of schemaSource.matchAll(TABLE_DECLARATION_RE)) {
        const start = match.index;
        const nextTable = schemaSource.slice(start + 1).search(NEXT_TABLE_RE);

        blocks.set(match[1] as string, schemaSource.slice(start, nextTable === -1 ? undefined : start + 1 + nextTable));
    }

    return blocks;
};

const blocks = tableBlocks();

describe("audit triggers", () => {
    it("parses the schema — guards the two regexes above", () => {
        expect(blocks.size, "no tables parsed out of schema.ts; TABLE_DECLARATION_RE has drifted").toBeGreaterThan(50);
        expect([...schemaSource.matchAll(AUDIT_CALL_RE)].length, "no auditTriggersFor calls parsed; AUDIT_CALL_RE has drifted").toBeGreaterThan(0);
    });

    it("wires every table in AUDIT_TABLES, and only those", () => {
        const wired = new Set([...schemaSource.matchAll(AUDIT_CALL_RE)].map((match) => match[1] as string));
        const listed = new Set(Object.keys(AUDIT_TABLES));

        // Listed-but-not-wired is the dangerous direction: no error, no audit row.
        expect(
            [...listed].filter((table) => !wired.has(table)),
            "in AUDIT_TABLES but never wired in schema.ts — these tables are silently un-audited",
        ).toStrictEqual([]);

        expect(
            [...wired].filter((table) => !listed.has(table)),
            "wired in schema.ts but missing from AUDIT_TABLES",
        ).toStrictEqual([]);
    });

    it("names the same table on both sides of each call", () => {
        const mismatched = [...schemaSource.matchAll(AUDIT_CALL_RE)]
            .filter((match) => match[1] !== match[2])
            .map((match) => `auditTriggersFor(t, "${match[1] as string}", AUDIT_TABLES["${match[2] as string}"]) — attribution taken from the wrong table`);

        expect(mismatched).toStrictEqual([]);
    });

    it("chains each call onto the table it names", () => {
        const misplaced: string[] = [];

        for (const [table, block] of blocks) {
            for (const call of block.matchAll(AUDIT_CALL_RE)) {
                if (call[1] !== table) {
                    misplaced.push(
                        `${table}: defineTable(…).triggers(… "${call[1] as string}" …) — audit trigger chained onto a different table than it names`,
                    );
                }
            }
        }

        expect(misplaced).toStrictEqual([]);
    });

    it("attributes through columns the schema still declares", () => {
        const auditSource = readFileSync(join(LUNORA_DIR, "lib/audit-triggers.ts"), "utf8");
        const listBody = auditSource.slice(auditSource.indexOf("export const AUDIT_TABLES"));
        const offenders: string[] = [];

        const entries = listBody.slice(0, listBody.indexOf("\n};")).matchAll(/^ {4}(\w+): \{(.*)\},?$/gm);

        for (const entry of entries) {
            const table = entry[1] as string;
            const block = blocks.get(table);

            if (block === undefined) {
                offenders.push(`${table} — in AUDIT_TABLES but not declared in schema.ts`);

                continue;
            }

            const columns = new Set([...block.matchAll(COLUMN_RE)].map((match) => match[1] as string));

            const reads = (entry[2] as string).matchAll(/d\["(\w+)"\]/g);

            for (const read of reads) {
                const column = read[1] as string;

                // `_id` / `_creationTime` are system fields, present on every row
                // and never written out in the table body.
                if (column.startsWith("_") || columns.has(column)) {
                    continue;
                }

                offenders.push(
                    `${table}.${column} — attribution reads a column schema.ts does not declare; asString() makes that an empty attribution, not an error`,
                );
            }
        }

        expect(offenders).toStrictEqual([]);
    });
});

describe("auditTriggersFor", () => {
    // Each builder method hands its handler straight back, so the handlers can be called directly.
    const passthrough = { afterDelete: (handler: unknown) => handler, afterInsert: (handler: unknown) => handler, afterUpdate: (handler: unknown) => handler };

    it("writes a non-null `doc` for a delete — the D1 column is NOT NULL", async () => {
        const inserted: Record<string, unknown>[] = [];
        const context = {
            db: {
                insert: async (_table: string, row: Record<string, unknown>) => {
                    inserted.push(row);

                    return "history-1";
                },
            },
        };
        const triggers = auditTriggersFor(passthrough as never, "userSettings", AUDIT_TABLES["userSettings"]!) as unknown as Record<
            string,
            (context: unknown, event: unknown) => Promise<void>
        >;

        await triggers.auditDelete!(context, { id: "settings-1", previous: { _id: "settings-1", userId: "user-1" } });

        expect(inserted).toHaveLength(1);
        expect(inserted[0]).toMatchObject({ doc: {}, documentId: "settings-1", isDeleted: true, userId: "user-1" });
        expect(inserted[0]!["doc"]).toBeDefined();
    });
});
