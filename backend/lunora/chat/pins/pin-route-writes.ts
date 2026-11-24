/**
 * The pins module's write surface for `sharedPinRoutes` during a guest merge (`lib/account-merge.ts`): a guest's route
 * moves to the new account only once the guest's pins on that thread have moved, so a route never names the account
 * while the guest still owns pins behind it.
 */
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/** One route that still names `userId`, or `null`. Primary: a route moved a moment ago must not come back. */
export const firstPinRouteOf = async (db: QueryCtx["db"], userId: string): Promise<{ ownerId: string; threadId: string } | null> => {
    const { page } = await db.sharedPinRoutes.findMany({ consistency: "primary", limit: 1, where: { userId } });
    const route = page.at(0);

    return route === undefined ? null : { ownerId: route.ownerId, threadId: route.threadId };
};

/**
 * The owner shard `userId`'s route on `threadId` names now, or `null` once there is none. Primary: an owner's merge re-points
 * it (`ownerId`) when it moves the thread, and a merge's second pin pass must see that at once.
 */
export const pinRouteOwnerOf = async (db: QueryCtx["db"], userId: string, threadId: string): Promise<string | null> => {
    const { page } = await db.sharedPinRoutes.findMany({ consistency: "primary", limit: 1, where: { threadId: threadId as never, userId } });

    return page.at(0)?.ownerId ?? null;
};

/** Whether a route still names `userId`: a guest is deleted only once none does. */
export const guestHasPinRoutes = async (db: MutationCtx["db"], userId: string): Promise<boolean> => (await firstPinRouteOf(db, userId)) !== null;

/**
 * Hands `from`'s route on `threadId` to `to`. Dropped instead where `to` already has its own route there (one per person
 * and thread), or owns the thread (an owner keeps no route to their own thread).
 */
export const moveSharedPinRoute = async (db: MutationCtx["db"], from: string, to: string, threadId: string): Promise<void> => {
    const { page } = await db.sharedPinRoutes.findMany({ consistency: "primary", limit: 10, where: { threadId: threadId as never, userId: from } });

    for (const route of page) {
        const { page: own } = await db.sharedPinRoutes.findMany({ consistency: "primary", limit: 1, where: { threadId: route.threadId, userId: to } });
        const kept = route.ownerId === to || own.length > 0;

        await (kept ? db.delete("sharedPinRoutes", route._id) : db.patch("sharedPinRoutes", route._id, { userId: to }));
    }
};
