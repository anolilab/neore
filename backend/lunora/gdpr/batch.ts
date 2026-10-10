/**
 * The erasure batch contract shared by the residual steps and every module's
 * `gdpr.ts`: at most {@link BATCH} rows per table per call, `{ hasMore }` back,
 * idempotent on retry. See `steps/residual-deletion-steps.ts`.
 */
import type { MutationCtx } from "../_generated/server";

/** Rows per table per round. */
export const BATCH = 100;

export type BatchResult = { hasMore: boolean };

/** `true` when a read came back full, i.e. there may be more behind it. */
export const full = (rows: ReadonlyArray<unknown>): boolean => rows.length >= BATCH;

type Row = { _id: string };

/**
 * Deletes a batch of parent rows with their children: up to {@link BATCH}
 * children per parent, and a parent only once none of its children are left.
 * `true` while anything may remain.
 *
 * One delete at a time, deliberately: on an audited table
 * (`lib/audit-triggers.ts`) every delete fires a trigger, and a `Promise.all`
 * over a batch nests them past the runtime's 50-level trigger-recursion limit.
 * The rows are local to the shard, so sequential costs little.
 */
/**
 * Deletes rows one at a time. Use this, not a `Promise.all`, for rows on an audited
 * table (`lib/audit-triggers.ts`): each delete fires a trigger, and a batch of them
 * in parallel nests the triggers past the runtime's 50-level limit.
 */
export const deleteOneByOne = async (context: MutationCtx, rows: ReadonlyArray<Row>): Promise<void> => {
    for (const row of rows) {
        await context.db.delete(row._id as never);
    }
};

export const deleteParentsWithChildren = async <P extends Row>(
    context: MutationCtx,
    parents: ReadonlyArray<P>,
    childrenOf: (parent: P) => Promise<Row[]>,
): Promise<boolean> => {
    let hasMore = parents.length >= BATCH;

    for (const parent of parents) {
        const children = await childrenOf(parent);

        for (const child of children) {
            await context.db.delete(child._id as never);
        }

        if (children.length >= BATCH) {
            hasMore = true;
            continue;
        }

        await context.db.delete(parent._id as never);
    }

    return hasMore;
};
