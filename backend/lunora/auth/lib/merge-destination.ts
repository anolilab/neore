import type { QueryCtx } from "../../_generated/server";

/**
 * Whether `userId` is still an account a guest merge may write into: its `user` row is there and is not a guest's. Read
 * from the primary, so an erasure that has just removed the row is seen. Once the account is erased, every claim tagged
 * with it is gone too, the erasing marker included, so a late merge job finds nothing else that would stop it.
 */
export const isMergeDestination = async (context: Pick<QueryCtx, "db">, userId: string): Promise<boolean> => {
    const user = (await context.db.user.findFirst({ consistency: "primary", where: { _id: context.db.asId("user", userId) } })) as {
        isAnonymous?: boolean | null;
    } | null;

    return user !== null && user.isAnonymous !== true;
};

/**
 * Whether `guestId` is still a guest a merge may move rows from: its `user` row is there and is a guest's. Read from the
 * primary, so the merge's own deletion of the guest, or an erasure, is seen at once.
 */
export const isMergeSource = async (context: Pick<QueryCtx, "db">, guestId: string): Promise<boolean> => (await mergeSourceState(context, guestId)) === "guest";

/**
 * What `guestId`'s `user` row is, from the primary: `guest`, `missing`, or `account` (a real user's, never a merge's source).
 * `missing` alone never means the merge is done: the anonymous plugin deletes the guest's row in the sign-up request that
 * queued the merge, before any of its rows have moved; only the merge's own progress says it got past its `guest` step.
 */
export const mergeSourceState = async (context: Pick<QueryCtx, "db">, guestId: string): Promise<"account" | "guest" | "missing"> => {
    const user = (await context.db.user.findFirst({ consistency: "primary", where: { _id: context.db.asId("user", guestId) } })) as {
        isAnonymous?: boolean | null;
    } | null;

    if (user === null) {
        return "missing";
    }

    return user.isAnonymous === true ? "guest" : "account";
};
