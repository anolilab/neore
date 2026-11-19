/**
 * The follows module's write surface for `threadFollows` that writers outside the module need (the account merge).
 */
import type { MutationCtx } from "../../_generated/server";
import { isUniqueViolation } from "../../lib/error-helpers";

/** Guest rows read per round of {@link mergeThreadFollowsOf}. */
const MERGE_BATCH = 100;

/** A guard against a page that never drains. A guest follows far fewer threads than this many batches. */
const MAX_MERGE_ROUNDS = 1000;

/**
 * An account merge: each of the guest's follow rows moves to the new account, unless the new account already has a
 * row for that thread, which wins (`by_user_and_thread` is unique). Returns how many rows moved.
 */
export const mergeThreadFollowsOf = async (db: MutationCtx["db"], from: string, to: string): Promise<number> => {
    let moved = 0;

    for (let round = 0; round < MAX_MERGE_ROUNDS; round += 1) {
        // Every row read is moved or deleted, so each round reads from the start again.
        const { page } = await db.threadFollows.findMany({ consistency: "primary", limit: MERGE_BATCH, where: { userId: from } });

        for (const row of page) {
            const kept = await db.threadFollows.findFirst({ consistency: "primary", where: { threadId: row.threadId, userId: to } });

            if (kept) {
                await db.delete("threadFollows", row._id);

                continue;
            }

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

        if (page.length < MERGE_BATCH) {
            break;
        }
    }

    return moved;
};
