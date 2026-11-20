/**
 * The follows module's surface for `threadFollows` that callers outside the module need (the account merge and the
 * deletion of a merged guest).
 */
import type { MutationCtx } from "../../_generated/server";
import { isUniqueViolation } from "../../lib/error-helpers";

/**
 * Guest rows moved per call of {@link mergeThreadFollowsPage}. A row costs up to three D1 queries (the new account's
 * lookup, then the patch's or delete's read and write), and a Workers Free invocation may run 50.
 */
export const FOLLOW_MERGE_PAGE_SIZE = 12;

/**
 * One page of an account merge: each of the guest's follow rows read moves to the new account, unless the new account
 * already has a row for that thread, which wins (`by_user_and_thread` is unique). The caller repeats it until
 * `hasMore` is false; every row read is moved or deleted, so each call reads from the start again.
 */
export const mergeThreadFollowsPage = async (db: MutationCtx["db"], from: string, to: string): Promise<{ hasMore: boolean; moved: number }> => {
    // One row past the page tells whether another call is needed.
    const { page } = await db.threadFollows.findMany({ consistency: "primary", limit: FOLLOW_MERGE_PAGE_SIZE + 1, where: { userId: from } });
    let moved = 0;

    for (const row of page.slice(0, FOLLOW_MERGE_PAGE_SIZE)) {
        const kept = await db.threadFollows.findFirst({ consistency: "primary", where: { threadId: row.threadId, userId: to } });

        if (kept) {
            await db.delete("threadFollows", row._id);

            continue;
        }

        // TODO(anolilab/lunora#1631): the patch and the deletes read the row on a replica. A lagging one fails the patch,
        // and the queue redelivers the merge; a delete it skips leaves the row for the next page to handle again.
        try {
            await db.patch("threadFollows", row._id, { userId: to });
            moved += 1;
        } catch (error) {
            // The new account wrote its own row for the thread since the read: it wins.
            if (!isUniqueViolation(error)) {
                throw error;
            }

            await db.delete("threadFollows", row._id);
        }
    }

    return { hasMore: page.length > FOLLOW_MERGE_PAGE_SIZE, moved };
};

/** Whether any follow row still names `userId`, read from the primary: a merged guest is deleted only once none does. */
export const guestHasFollowRows = async (db: MutationCtx["db"], userId: string): Promise<boolean> =>
    (await db.threadFollows.findFirst({ consistency: "primary", where: { userId } })) !== null;
