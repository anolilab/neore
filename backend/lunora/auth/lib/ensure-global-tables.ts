import { runD1GlobalTableMigrations } from "@lunora/d1";
import lunoraD1Package from "@lunora/d1/package.json";

import schema from "../../schema";

type SqlExec = Parameters<typeof runD1GlobalTableMigrations>[0];
type SchemaLike = Parameters<typeof runD1GlobalTableMigrations>[1];

/**
 * Raw table recording which schema fingerprints have been fully provisioned —
 * like `wsTicket`, it is ours, not a schema table, so Lunora never touches it.
 */
const MARKER_TABLE = "globalSchemaMarker";

let ensured: Promise<void> | undefined;

/**
 * SHA-256 over everything the provisioner derives DDL from: each `.global()`
 * table's definition (shape, indexes, unique columns — functions such as
 * triggers drop out of the JSON) plus the `@lunora/d1` version, because a
 * Lunora bump can change the DDL for an unchanged schema (a framework column,
 * an index layout). Any change to either means a new fingerprint, and so one
 * full sweep.
 */
export const globalSchemaFingerprint = async (schemaLike: { tables: Record<string, { shardMode?: { kind?: string } }> }): Promise<string> => {
    const globalTables = Object.entries(schemaLike.tables).filter(([, table]) => table.shardMode?.kind === "global");
    const source = JSON.stringify([lunoraD1Package.version, globalTables], (_key, value: unknown) => (typeof value === "function" ? undefined : value));
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));

    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const isProvisioned = async (exec: SqlExec, fingerprint: string): Promise<boolean> => {
    try {
        const rows = await exec.all(`SELECT 1 FROM "${MARKER_TABLE}" WHERE "fingerprint" = ? LIMIT 1`, [fingerprint]);

        return rows.length > 0;
    } catch {
        // No marker table yet: a database this code has never provisioned.
        return false;
    }
};

const provision = async (exec: SqlExec): Promise<void> => {
    // `schema` is structurally the same shape, but the tree carries more than
    // one `@lunora`/* copy (see AGENTS.md), so `TriggerDefinition` here and
    // `TriggerDefinitionLike` in the copy `@lunora/d1` was built against are
    // nominally distinct and the assignment is rejected. The cast is confined
    // to this one call rather than pushed out to the caller.
    const schemaLike = schema as unknown as SchemaLike & { tables: Record<string, { shardMode?: { kind?: string } }> };
    const fingerprint = await globalSchemaFingerprint(schemaLike);

    if (await isProvisioned(exec, fingerprint)) {
        return;
    }

    await runD1GlobalTableMigrations(exec, schemaLike);

    // Recorded only after the sweep succeeded, so a failed one is retried by
    // the next isolate. Two isolates racing both sweep (idempotent) and both
    // insert; `OR IGNORE` makes the second a no-op.
    await exec.run(`CREATE TABLE IF NOT EXISTS "${MARKER_TABLE}" ("fingerprint" TEXT PRIMARY KEY, "provisionedAt" INTEGER NOT NULL)`, []);
    await exec.run(`INSERT OR IGNORE INTO "${MARKER_TABLE}" ("fingerprint", "provisionedAt") VALUES (?, ?)`, [fingerprint, Date.now()]);
};

/** Test seam: forget this isolate's memo. */
export const resetEnsureGlobalTablesForTests = (): void => {
    ensured = undefined;
};

// `no-secrets` scores the doc block below on entropy and trips on the helper's
// own name; the same suppression pattern as `crons.ts:303`.
// eslint-disable-next-line no-secrets/no-secrets
/**
 * Create the schema's `.global()` D1 tables before better-auth touches them.
 *
 * `.global()` tables are provisioned LAZILY, on first access through Lunora's
 * ORM facade (`ctx.db.<table>`). better-auth never goes through that facade —
 * `createSqlAuthStore(d1Executor(env.DB))` issues raw SQL — so against a
 * database no ORM read has ever touched, its first statement hits a table that
 * does not exist:
 *
 *     D1_ERROR: no such table: rateLimit: SQLITE_ERROR
 *       at `@lunora/auth`/dist/sql-store.mjs … findMany
 *
 * `rateLimit` is first because better-auth's durable rate limiter runs before
 * every handler, so this is not a sign-up-only fault — it is every
 * `/api/auth/*` route, `get-session` included. It cannot self-heal either: the
 * auth path never performs the ORM read that would create the table, so a fresh
 * deployment stays broken until something unrelated happens to touch it.
 *
 * Reproduced by deleting `backend/.wrangler/state/v3/d1` and posting a sign-up:
 * 500, and `sqlite_master` still empty afterwards.
 *
 * `server.ts` used to call better-auth's own `ensureMigrated` and it was removed
 * for good reasons (it drives a migrator the Lunora D1 adapter does not support,
 * and calls `process.exit` inside the isolate). The comment left behind reasoned
 * "Lunora owns their shape; better-auth has nothing left to create" — half
 * right. Lunora owns the shape; nothing was creating the tables. This closes the
 * gap with Lunora's own provisioner, so the shape stays owned by `schema.ts`
 * alone: `runD1GlobalTableMigrations` emits idempotent
 * `CREATE TABLE IF NOT EXISTS` derived from it.
 *
 * Memoised per isolate, and skipped per DATABASE once done: the sweep is
 * idempotent but far from free — ~370 sequential statements for the 42 global
 * tables (a CREATE, a column probe and a sqlite_master read + CREATE INDEX per
 * index, per table), which every cold isolate paid on its first request —
 * any route, since `server.ts` awaits this ahead of the router.
 * Now a cold isolate pays ONE read of `globalSchemaMarker` and sweeps only when
 * the schema's fingerprint (see `globalSchemaFingerprint`) has never been
 * provisioned on this database — i.e. once per schema change, per database.
 *
 * The marker cannot see a table dropped by hand behind its back; drop the
 * marker row with it. The ORM facade's own lazy sweep inside the Durable
 * Object is Lunora's and still runs once per DO isolate.
 *
 * A failure clears the memo, so the next request retries instead of caching a
 * broken database for the isolate's lifetime.
 */
export const ensureGlobalTables = async (exec: SqlExec): Promise<void> => {
    ensured ??= provision(exec).catch((error: unknown) => {
        ensured = undefined;

        throw error;
    });

    await ensured;
};
