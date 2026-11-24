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
