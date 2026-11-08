/**
 * The notifications module's write surface for `pushDevices`, for writers outside
 * the module (the account merge) as well as its own procedures.
 */
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

/** Phones one user may register; the one not seen for longest is dropped past this. */
export const MAX_PUSH_DEVICES_PER_USER = 10;

/**
 * Deletes a row read earlier only if it is still the same registration: the same owner, not seen since. Another
 * account may have taken the phone over, or the phone registered again, after the first read; that registration
 * stays. The check and the delete are two statements (the global table offers no conditional delete), so a write
 * landing between them can still lose its row; the app registers again on its next return to the foreground.
 */
export const deleteIfUnchanged = async (db: MutationCtx["db"], read: Doc<"pushDevices">): Promise<boolean> => {
    const current = await db.pushDevices.findFirst({ consistency: "primary", where: { _id: read._id } });

    if (current?.userId !== read.userId || current.lastSeenAt !== read.lastSeenAt) {
        return false;
    }

    await db.delete("pushDevices", read._id);

    return true;
};

/**
 * An account merge: the guest's phones were registered under the guest's session, which ends with the guest, so they
 * are dropped rather than moved; the phone registers again under the new account's sign-in. Loops until none is left.
 */
export const dropPushDevicesOf = async (db: MutationCtx["db"], userId: string): Promise<number> => {
    let removed = 0;

    for (;;) {
        const { page } = await db.pushDevices.findMany({ consistency: "primary", limit: MAX_PUSH_DEVICES_PER_USER * 3, where: { userId } });

        for (const device of page) {
            if (await deleteIfUnchanged(db, device)) {
                removed += 1;
            }
        }

        if (page.length < MAX_PUSH_DEVICES_PER_USER * 3) {
            return removed;
        }
    }
};

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
            if (await deleteIfUnchanged(db, device)) {
                removed += 1;
            }
        }

        if (page.length < MAX_PUSH_DEVICES_PER_USER * 3) {
            return removed;
        }
    }
};
