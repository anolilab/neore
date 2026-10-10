/**
 * Brings `@lunora/testing`'s harness to production parity in two ways the
 * per-user-sharding change (docs/plans/per-user-sharding.md) depends on. (A
 * third, ORM facades on every `ctx.db`, went: the harness binds them itself
 * since `@lunora/testing@alpha.246`.)
 *
 * 1. **`.global()` tables on the shard engine.** The harness has no D1 backend,
 *    so any write to a `.global()` table throws "requires a globalDb writer".
 *    Here they are declared `.shardBy("userId")` instead: same rows, same ORM
 *    reads, one SQLite. A LEGACY `ctx.db.query(<global table>)` read would pass
 *    on that — `lunora/lib/global-table-reader.test.ts` is what catches those.
 *
 * Applied under `vi.mock`, which a setup file applies to every suite.
 */
import { vi } from "vitest";

vi.mock(import("../lunora/schema"), async (importOriginal) => {
    const original = await importOriginal();
    const schema = original.default as unknown as { tables: Record<string, { shardMode?: { kind?: string } }> };
    const tables: Record<string, object> = {};

    for (const [name, table] of Object.entries(schema.tables)) {
        tables[name] =
            table.shardMode?.kind === "global"
                ? Object.assign(Object.create(Object.getPrototypeOf(table) as object | null) as object, table, {
                      shardMode: { field: "userId", kind: "shardBy" },
                  })
                : table;
    }

    return {
        ...original,
        default: Object.assign(Object.create(Object.getPrototypeOf(schema) as object | null) as object, schema, { tables }) as typeof original.default,
    };
});

/**
 * 2. **`callOnShard` runs in the harness.** Production reaches another user's
 *    shard through the `SHARD` binding (`lunora/lib/cross-shard.ts`); the harness
 *    is one database standing in for every shard, so a cross-shard call is a
 *    plain system dispatch on the most recently created harness.
 */
const harnesses = vi.hoisted(() => {
    return { latest: undefined as undefined | { run: (callback: (ctx: never) => Promise<unknown>) => Promise<unknown> } };
});

vi.mock(import("@lunora/testing"), async (importOriginal) => {
    const original = await importOriginal();

    return {
        ...original,
        lunoraTest: ((...arguments_: Parameters<typeof original.lunoraTest>) => {
            const harness = original.lunoraTest(...arguments_);

            harnesses.latest = harness as never;

            return harness;
        }) as typeof original.lunoraTest,
    };
});

vi.mock(import("../lunora/lib/cross-shard"), () => {
    return {
        callOnShard: (async (reference: { __lunoraRef?: string; kind?: string }, args: Record<string, unknown>) => {
            const harness = harnesses.latest;

            if (!harness) {
                throw new Error("callOnShard: no lunoraTest harness has been created in this test file");
            }

            // A suite that resolves references to registered procedures (see
            // `lib/rls/rls.test.ts`) hands over the procedure, which knows its kind.
            const registered = reference.kind === undefined ? await import("../lunora/_generated/functions") : undefined;
            const kind = reference.kind ?? registered?.LUNORA_FUNCTIONS[reference.__lunoraRef ?? ""]?.kind;
            const methods: Record<string, string> = { action: "runAction", mutation: "runMutation" };
            const method = methods[kind ?? ""] ?? "runQuery";

            return await harness.run(
                async (ctx: never) => await (ctx as Record<string, (r: unknown, a: unknown) => Promise<unknown>>)[method]!(reference, args),
            );
        }) as never,
    };
});
