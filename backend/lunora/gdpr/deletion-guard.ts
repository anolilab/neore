import { LunoraError } from "lunorash/server";

import type { QueryCtx } from "../_generated/server";
import { DELETION_SESSION_FRESH_AGE_MS } from "./constants";

/** The `data.code` the web dialog maps to "sign out and sign back in". */
export const SESSION_NOT_FRESH = "SESSION_NOT_FRESH";

interface DeletionSession {
    createdAt: number;
    impersonatedBy?: string | null;
}

/**
 * Server-side re-authentication for `requestAccountDeletion`.
 *
 * Deletion starts erasing immediately and takes no password, so the session is
 * the only credential — which makes it the thing to check. better-auth's own
 * `deleteUser` demanded a FRESH session (signed in within `freshAge`); this is
 * that rule, enforced where a script cannot skip it. The dialog's client-side
 * freshness check is UX only.
 *
 * Refuses: no session row (nothing to prove recency with), an impersonated
 * session (an admin must never erase the user they are acting as), and a
 * session older than {@link DELETION_SESSION_FRESH_AGE_MS}.
 */
export const assertAccountDeletionAllowed = (session: DeletionSession | null, now: number = Date.now()): void => {
    if (session?.impersonatedBy) {
        throw new LunoraError("FORBIDDEN", "Account deletion is not available while impersonating");
    }

    if (!session || now - session.createdAt >= DELETION_SESSION_FRESH_AGE_MS) {
        throw new LunoraError("FORBIDDEN", "Please sign in again to delete your account", {
            data: { code: SESSION_NOT_FRESH, message: "Please sign in again to delete your account" },
        });
    }
};

/**
 * Whether `userId`'s account is being erased, or has been. Background work that
 * CREATES user data — a scheduled task round, say — must check this and stand
 * down: the deletion workflow removes each table once, in order, so a row
 * written behind a step that already ran survives the erasure.
 */
export const isAccountDeletionUnderway = async (ctx: QueryCtx, userId: string): Promise<boolean> => {
    const request = await ctx.db
        .query("gdprRequests")
        .withIndex("by_user_and_type", (q) => q.eq("userId", userId).eq("requestType", "deletion"))
        .order("desc")
        .first();

    return request?.status === "pending" || request?.status === "processing" || request?.status === "completed";
};
