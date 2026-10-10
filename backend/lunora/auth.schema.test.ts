/**
 * The better-auth tables in `schema.ts` are hand-maintained copies of
 * better-auth's own schema, and every better-auth release can add a column.
 *
 * Since 1.7.3 better-auth checks the store at init (via `lunoraD1Adapter`, which
 * introspects D1 with `PRAGMA table_info`) and fails EVERY auth request with a
 * `SchemaMismatchError` when a column it writes is missing — or when a column it
 * never writes is required, so its inserts would fail. The bump to 1.7.3 did
 * exactly that: seven missing columns and a required `teamMember.role`, found
 * only by a dead dev stack.
 *
 * This runs the same two rules as better-auth's `diffSchema` against `schema.ts`
 * instead of against a live database, for the options `buildAuthOptions`
 * actually installs. `diffSchema` itself lives in `@better-auth/core/db/internal`,
 * which is not a dependency here; `getSchema` from `better-auth/db` is public and
 * yields the same field map.
 */
import { getSchema } from "better-auth/db";
import { describe, expect, it } from "vitest";

import { buildAuthOptions } from "./auth";
import { schema } from "./schema";

type Validator = { _meta?: { inner?: Validator }; kind: string };

/** Columns Lunora adds to every table; the adapter treats them as filled. */
const SYSTEM_COLUMNS = new Set(["_creationTime", "_version", "id"]);

/** better-auth field type → the Lunora validator kind this schema stores it as. */
const STORED_KIND: Record<string, string> = {
    boolean: "boolean",
    date: "number",
    number: "number",
    string: "string",
};

const unwrapOptional = (validator: Validator): { kind: string; optional: boolean } =>
    validator.kind === "optional" && validator._meta?.inner ? { kind: validator._meta.inner.kind, optional: true } : { kind: validator.kind, optional: false };

const expected = Object.entries(getSchema(buildAuthOptions())).filter(([, table]) => !table.disableMigrations);

const shapeOf = (table: string): Record<string, Validator> | undefined =>
    (schema.tables as Record<string, { shape: Record<string, Validator> } | undefined>)[table]?.shape;

describe("schema.ts covers every better-auth table", () => {
    it("declares every table better-auth writes", () => {
        const missing = expected.map(([table]) => table).filter((table) => !shapeOf(table));

        expect(missing, "better-auth table(s) absent from schema.ts").toStrictEqual([]);
    });

    describe.each(expected)("%s", (table, { fields }) => {
        const shape = shapeOf(table) ?? {};

        it("declares every column better-auth writes", () => {
            const missing = Object.keys(fields).filter((column) => !(column in shape));

            expect(missing, `column(s) better-auth writes that ${table} lacks — every auth request fails with SchemaMismatchError`).toStrictEqual([]);
        });

        it("requires no column better-auth never writes", () => {
            const required = Object.entries(shape)
                .filter(([column, validator]) => !(column in fields) && !SYSTEM_COLUMNS.has(column) && !unwrapOptional(validator).optional)
                .map(([column]) => column);

            expect(required, `required column(s) on ${table} that better-auth never writes — its inserts fail`).toStrictEqual([]);
        });

        it("stores each column as the type better-auth writes", () => {
            const mismatched = Object.entries(fields)
                .filter(([column, field]) => {
                    const validator = shape[column];
                    const kind = typeof field.type === "string" ? STORED_KIND[field.type] : undefined;

                    // Array and literal-union fields have no single kind to compare.
                    if (!validator || !kind) {
                        return false;
                    }

                    const stored = unwrapOptional(validator).kind;

                    return stored !== kind && !(kind === "string" && stored === "union");
                })
                .map(([column, field]) => `${column}: better-auth ${String(field.type)}, schema ${unwrapOptional(shape[column]!).kind}`);

            expect(mismatched).toStrictEqual([]);
        });
    });
});
