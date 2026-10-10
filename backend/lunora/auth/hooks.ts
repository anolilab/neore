/**
 * The data-layer half of the better-auth lifecycle hooks.
 *
 * Side effects cannot run inline in the auth write: better-auth's own
 * `databaseHooks` — which is what Lunora exposes — hand you the row and the
 * better-auth context, and nothing that can reach `ctx.db`.
 *
 * So the bodies move here as internal mutations, and `auth.ts` invokes them
 * through a shard client. Each is written to be **idempotent and independently
 * safe**: they run outside the auth transaction, so
 * a failure between the auth write and the hook must not corrupt state. That is
 * why creation is "insert if absent" and deletion tolerates missing rows.
 *
 * `userSettings` / `aiUserPreferences` are `.shardBy("userId")`; `session`,
 * `account`, `member` and `twoFactor` are `.global()`. One mutation can touch
 * both because `.global()` tables are routed to D1 from inside ANY shard.
 *
 * **These run on the user's own shard** (`forShard(userId)` in `auth.ts`), which
 * is where every request of theirs lands (`src/shard-routing.ts`,
 * docs/plans/per-user-sharding.md). They ran on `__root__` while nothing named a
 * shard; the two move together.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { ADMIN } from "../env";
import { noteShardActivity } from "../lib/shard-housekeeping";
import { deleteShardRoutesOf } from "../lib/shard-routes";

/** Emails in the `ADMIN` allowlist, trimmed and lowercased. */
export const adminEmails = (): string[] =>
    ADMIN
        ? ADMIN.split(",")
              .map((entry) => entry.trim().toLowerCase())
              .filter(Boolean)
        : [];

/**
 * Seed a new user's default rows.
 *
 * The timezone on `userSettings` is deliberately left unset — the client writes
 * the real one after registration.
 */
export const initializeUserDefaults = internalMutation.input({ userId: v.id("user") }).mutation(async ({ args, ctx }) => {
    const existingSettings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (!existingSettings) {
        await ctx.db.insert("userSettings", { userId: args.userId });
    }

    const existingPreferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (!existingPreferences) {
        await ctx.db.insert("aiUserPreferences", { userId: args.userId });
    }

    // Enter the new shard in the census the root cron sweeps (`lib/shard-housekeeping.ts`).
    await noteShardActivity(ctx, args.userId);
});

/**
 * Apply the admin role retroactively once an allowlisted email is verified.
 *
 * The create-side hook only grants admin when `emailVerified` is already true at
 * signup — that gates the email/password path, where an attacker who learns an
 * admin's address could otherwise pre-claim the role. This closes the loop for
 * users who verify afterwards.
 */
export const promoteVerifiedAdmin = internalMutation.input({ userId: v.id("user") }).mutation(async ({ args, ctx }) => {
    const user = await ctx.db.user.findFirst({ where: { _id: args.userId } });

    if (!user || !user.emailVerified || user.role === "admin") {
        return;
    }

    if (adminEmails().includes(user.email.toLowerCase())) {
        await ctx.db.patch(args.userId, { role: "admin" });
    }
});

/** Cascade-delete everything keyed to a user that better-auth does not own. */
export const cascadeDeleteUser = internalMutation.input({ userId: v.id("user") }).mutation(async ({ args, ctx }) => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (settings) {
        await ctx.db.delete(settings._id);
    }

    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (preferences) {
        await ctx.db.delete(preferences._id);
    }

    // better-auth may already have removed these; the sweep is belt-and-braces
    // and is why every branch tolerates an empty result.
    //
    // One `findMany` per table rather than a loop over the names: all three are
    // `.global()`, so the legacy `query()/withIndex()` reader is not available on
    // them (it threw at runtime until the generated `ctx.db.query()` guard made it
    // a compile error), and the facade is typed per table. Paged to exhaustion —
    // a session or account left behind is a credential that still works.
    const userId = args.userId as Id<"user">;
    const sessions = await ctx.db.session.findMany({ where: { userId } }).then((result) => result.page);
    const accounts = await ctx.db.account.findMany({ where: { userId } }).then((result) => result.page);
    const memberships = await ctx.db.member.findMany({ where: { userId } }).then((result) => result.page);

    for (const row of sessions) {
        await ctx.db.delete(row._id);
    }

    for (const row of accounts) {
        await ctx.db.delete(row._id);
    }

    for (const row of memberships) {
        await ctx.db.delete(row._id);
    }

    const twoFactorDocument = await ctx.db.twoFactor.findFirst({ where: { userId: args.userId as Id<"user"> } });

    if (twoFactorDocument) {
        await ctx.db.delete(twoFactorDocument._id);
    }

    const { page: passkeys } = await ctx.db.passkey.findMany({ where: { userId: args.userId as string } });

    for (const row of passkeys) {
        await ctx.db.delete(row._id);
    }

    // `.global()` pointers at this user's shard: webhook/public-link routes and
    // the housekeeping census.
    await deleteShardRoutesOf(ctx, args.userId);
});

/**
 * Delete the `user` row itself — the last step of the admin cleanup of an
 * inactive anonymous user (`admin_cleanup.executeCleanup`), after
 * {@link cascadeDeleteUser}. Here because this module owns `user`.
 */
export const deleteUserRecord = internalMutation
    .input({ userDocId: v.id("user") })
    .output(v.null())
    .mutation(async ({ args: { userDocId }, ctx }) => {
        await ctx.db.delete(userDocId);

        return null;
    });
