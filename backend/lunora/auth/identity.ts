/**
 * The profile half of an identity, for contexts that cannot read the database
 * directly.
 *
 * `getAuthUserIdentity` (`auth/session.ts`) reads the `user` row with
 * `context.db.get`, which only a query or mutation has. HTTP actions and actions
 * carry `auth` but no `db`, so `getCurrentUserInternal` resolves the user id from
 * `context.auth` and the profile through this query. Reaching it through
 * `getAuthUserIdentity` threw "Cannot read properties of undefined (reading
 * 'get')" inside `/chat/start`, which answered every chat message with 401.
 *
 * The caller supplies a user id it already authenticated — this is internal and
 * trusts it.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalQuery } from "../_generated/server";

export const getUserProfileForIdentity = internalQuery
    .input({ userId: v.string() })
    .output(
        v.union(
            v.null(),
            v.object({
                email: v.string(),
                image: v.optional(v.string()),
                name: v.optional(v.string()),
            }),
        ),
    )
    .query(async ({ args: { userId }, ctx }) => {
        const user = await ctx.db.user.findFirst({ where: { _id: userId as Id<"user"> } });

        if (!user) {
            return null;
        }

        return {
            email: user.email,
            ...(user.image && { image: user.image }),
            ...(user.name && { name: user.name }),
        };
    });
