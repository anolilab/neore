/**
 * The erasure batch contract shared by the residual steps and every module's
 * `gdpr.ts`: at most {@link BATCH} rows per table per call, `{ hasMore }` back,
 * idempotent on retry. See `steps/residual-deletion-steps.ts`.
 */

/** Rows per table per round. */
export const BATCH = 100;

export type BatchResult = { hasMore: boolean };

/** `true` when a read came back full, i.e. there may be more behind it. */
export const full = (rows: ReadonlyArray<unknown>): boolean => rows.length >= BATCH;

type Row = { _id: string };

/**
 * Deletes rows one at a time through `remove`. Use this, not a `Promise.all`, for rows
 * on an audited table (`lib/audit-triggers.ts`): each delete fires a trigger, and a batch
 * of them in parallel nests the triggers past the runtime's 50-level limit.
 *
 * The caller passes the delete (`(row) => ctx.db.delete("table", row._id)`) so the
 * write names its table at the call site, in the module that owns it: a `TableName`
 * parameter here reads to the advisor as a write to every table.
 */
export const deleteOneByOne = async <R extends Row>(rows: ReadonlyArray<R>, remove: (row: R) => Promise<unknown>): Promise<void> => {
    for (const row of rows) {
        await remove(row);
    }
};

/**
 * Deletes a batch of parent rows with their children: up to {@link BATCH}
 * children per parent, and a parent only once none of its children are left.
 * `true` while anything may remain. Sequential for the same trigger-recursion
 * reason as {@link deleteOneByOne}, and the deletes come from the caller for the
 * same advisor reason.
 */
export const deleteParentsWithChildren = async <P extends Row, C extends Row>(
    parents: ReadonlyArray<P>,
    childrenOf: (parent: P) => Promise<C[]>,
    remove: { child: (child: C) => Promise<unknown>; parent: (parent: P) => Promise<unknown> },
): Promise<boolean> => {
    let hasMore = parents.length >= BATCH;

    for (const parent of parents) {
        const children = await childrenOf(parent);

        for (const child of children) {
            await remove.child(child);
        }

        if (children.length >= BATCH) {
            hasMore = true;
            continue;
        }

        await remove.parent(parent);
    }

    return hasMore;
};
