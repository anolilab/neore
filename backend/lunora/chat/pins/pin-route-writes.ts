/**
 * The pins module's write surface for `sharedPinRoutes` during a guest merge (`lib/account-merge.ts`): a guest's route
 * moves to the new account only once the guest's pins on that thread have moved, so a route never names the account
 * while the guest still owns pins behind it.
 */
import type { MutationCtx, QueryCtx } from "../../_generated/server";

/** One route that still names `userId`, or `null`. Primary: a route moved a moment ago must not come back. */
export const firstPinRouteOf = async (db: QueryCtx["db"], userId: string): Promise<{ ownerId: string; threadId: string } | null> => {
    const route = await db.sharedPinRoutes.findFirst({ consistency: "primary", where: { userId } });

    return route === null ? null : { ownerId: route.ownerId, threadId: route.threadId };
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
        const kept =
            route.ownerId === to || (await db.sharedPinRoutes.findFirst({ consistency: "primary", where: { threadId: route.threadId, userId: to } })) !== null;

        await (kept ? db.delete("sharedPinRoutes", route._id) : db.patch("sharedPinRoutes", route._id, { userId: to }));
    }
};
