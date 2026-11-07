/**
 * The notifications module's write surface for `pushDevices`, for writers outside
 * the module (the account merge) as well as its own procedures.
 */
import type { MutationCtx } from "../_generated/server";

/** Phones one user may register; the one not seen for longest is dropped past this. */
export const MAX_PUSH_DEVICES_PER_USER = 10;

/**
 * Keeps the `MAX_PUSH_DEVICES_PER_USER` phones of `userId` seen most recently and
 * deletes the rest. Registration adds one phone at a time; an account merge can
 * bring a whole second set, so the read is bounded by twice the cap plus a margin
 * and the trim loops until it is under.
 */
export const trimPushDevices = async (db: MutationCtx["db"], userId: string): Promise<number> => {
    let removed = 0;

    for (;;) {
        const { page } = await db.pushDevices.findMany({
            consistency: "primary",
            limit: MAX_PUSH_DEVICES_PER_USER * 3,
            orderBy: [{ lastSeenAt: "desc" }],
            where: { userId },
        });
        const excess = page.slice(MAX_PUSH_DEVICES_PER_USER);

        for (const device of excess) {
            await db.delete("pushDevices", device._id);
        }

        removed += excess.length;

        if (page.length < MAX_PUSH_DEVICES_PER_USER * 3) {
            return removed;
        }
    }
};
