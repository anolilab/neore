/**
 * Test-only: `schema` with the named `.global()` tables re-declared as
 * `.shardBy("userId")`.
 *
 * `lunoraTest`'s in-memory harness has no global (D1) backend — inserting into a
 * `.global()` table throws "requires a globalDb writer". A test that only needs
 * such a table as a fixture can run it on the shard engine instead. The ORM
 * facade (`ctx.db.<table>.findMany/findFirst`) reads the same on both, but the
 * legacy `ctx.db.query(...)` reader works ONLY on the shard engine, so a test on
 * this schema cannot catch a legacy read of a global table —
 * `lib/global-table-reader.test.ts` is what guards that.
 */
import { bindTableFacade } from "lunorash/server";

import schema from "../schema";

export const schemaWithShardedTables = (tables: ReadonlyArray<string>): typeof schema => {
    const source = schema as unknown as { tables: Record<string, object> };
    const overridden: Record<string, object> = { ...source.tables };

    for (const name of tables) {
        const table = source.tables[name];

        if (!table) {
            throw new Error(`schemaWithShardedTables: no table "${name}"`);
        }

        overridden[name] = Object.assign(Object.create(Object.getPrototypeOf(table) as object | null) as object, table, {
            shardMode: { field: "userId", kind: "shardBy" },
        });
    }

    return Object.assign(Object.create(Object.getPrototypeOf(schema) as object | null) as object, schema, { tables: overridden }) as typeof schema;
};

/**
 * Test-only: `ctx` with `ctx.db.<table>` (the ORM facade) bound.
 *
 * In production the runtime gives every procedure the facade. The bare
 * `lunoraTest` harness does not (`test/setup-harness.ts` now binds it for every
 * suite) — so without that setup a bare `_generated/server` procedure that reads a
 * `.global()` table through `ctx.db.<table>.findMany(...)` sees `undefined`
 * there. Call such a procedure's `handler` with this context instead of
 * dispatching it through `ctx.runMutation`.
 */
export const withTableFacades = <C extends { db: object }>(ctx: C): C => {
    const facades = new Map<string, unknown>();
    const db = new Proxy(ctx.db as Record<string, unknown>, {
        get: (target, property, receiver) => {
            if (typeof property === "string" && !(property in target) && property in (schema as unknown as { tables: Record<string, unknown> }).tables) {
                if (!facades.has(property)) {
                    facades.set(property, bindTableFacade(target as never, property));
                }

                return facades.get(property);
            }

            return Reflect.get(target, property, receiver) as unknown;
        },
    });

    return { ...ctx, db };
};
