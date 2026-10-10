/**
 * Document version history — an in-repo audit-history component, inlined.
 *
 * The component was an in-repo component with its own `history` and
 * `vacuumState` tables, mounted as `components.auditHistory`. **Lunora has no
 * component system**, so the tables live in our own `schema.ts`
 * (`documentHistory`) and the functions live here. Anything else that would have
 * been a component has to be inlined the same way.
 *
 * This is a **read** surface, not a write-only log — GDPR uses
 * {@link listUserActivity} for the data export and {@link getDocumentAtTime} for
 * point-in-time reconstruction, and the canvas version-history panel reads it —
 * so it had to be ported rather than stubbed.
 *
 * Not ported: the component's `vacuumState` bookkeeping. {@link vacuumHistory}
 * deletes in bounded batches and reports how many it removed, which is what the
 * caller (a cron) actually needs; tracking the last vacuum position in a table
 * bought nothing once the delete became idempotent.
 */
import { v } from "lunorash/server";

import { internalMutation, internalQuery } from "../_generated/server";

/**
 * Rows per batch. Exported because `crons.ts` compares `vacuumHistory`'s return
 * against it to decide whether to reschedule — a second hardcoded 200 there
 * would silently stop vacuuming early if this ever changed.
 */
export const HISTORY_PAGE = 200;

/** Record one change. `doc` is the new state; `null` means the row was deleted. */
export const recordHistory = internalMutation
    .input({
        attribution: v.optional(v.any()),
        doc: v.any(),
        documentId: v.string(),
        isDeleted: v.boolean(),
        oldDoc: v.optional(v.any()),
        organizationId: v.optional(v.string()),
        tableName: v.string(),
        userId: v.optional(v.string()),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // Deletions pass `doc: null`, but `doc` is `v.any()`, a NOT NULL column
        // in D1 — so every hard/soft thread delete failed here with
        // `NOT NULL constraint failed: documentHistory.doc`, rolling the delete
        // back. `isDeleted` is what readers check (`getDocumentAtTime` answers
        // null for it), so the stored value for a deletion is an empty object.
        await ctx.db.insert("documentHistory", { ...args, doc: args.doc ?? {}, ts: ctx.now });

        return null;
    });

/** Every change a user made, newest first. The GDPR export reads this. */
export const listUserActivity = internalQuery
    .input({ limit: v.optional(v.number()), userId: v.string() })
    .query(
        async ({ args, ctx }) =>
            await ctx.db.documentHistory
                .findMany({ limit: args.limit ?? HISTORY_PAGE, orderBy: [{ ts: "desc" }], where: { userId: args.userId } })
                .then((result) => result.page),
    );

/**
 * The state of one document as of `timestamp`.
 *
 * The newest entry at or before `timestamp` already holds the full document, so
 * this is a single indexed read rather than a replay — the component stored
 * snapshots, not diffs. Returns `null` when the document did not exist yet, and
 * also when it had been deleted (`isDeleted`), which are the same thing to a
 * caller reconstructing state.
 */
export const getDocumentAtTime = internalQuery
    .input({ documentId: v.string(), tableName: v.string(), timestamp: v.number() })
    .output(v.union(v.any(), v.null()))
    .query(async ({ args, ctx }) => {
        const entry = await ctx.db.documentHistory.findFirst({
            orderBy: [{ ts: "desc" }],
            where: { documentId: args.documentId, tableName: args.tableName, ts: { lte: args.timestamp } },
        });

        return entry && !entry.isDeleted ? entry.doc : null;
    });

/** Every recorded version of one document, newest first. Backs the canvas history panel. */
export const listDocumentVersions = internalQuery.input({ documentId: v.string(), limit: v.optional(v.number()), tableName: v.string() }).query(
    async ({ args, ctx }) =>
        await ctx.db.documentHistory
            .findMany({
                limit: args.limit ?? HISTORY_PAGE,
                orderBy: [{ ts: "desc" }],
                where: { documentId: args.documentId, tableName: args.tableName },
            })
            .then((result) => result.page),
);

/**
 * Drop entries older than `minTsToKeep`, in one bounded batch.
 *
 * Bounded rather than exhaustive because this runs inside a mutation, and a
 * transaction that deletes an unbounded number of rows is a way to hit a limit
 * on a busy deployment. The caller re-runs while `removed` equals the batch size.
 */
export const vacuumHistory = internalMutation
    .input({ minTsToKeep: v.number() })
    .output(v.number())
    .mutation(async ({ args, ctx }) => {
        const { page: stale } = await ctx.db.documentHistory.findMany({ limit: HISTORY_PAGE, where: { ts: { lt: args.minTsToKeep } } });

        for (const entry of stale) {
            await ctx.db.delete(entry._id);
        }

        return stale.length;
    });
