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
 * is where every request of theirs lands (`src/shard-routing.ts`). They ran on `__root__` while nothing named a
 * shard; the two move together.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalMutation } from "../_generated/server";
import { guestHoldsGrantRows } from "../agent/grant-revision";
import { guestHasFollowRows } from "../chat/follows/follow-writes";
import { guestHasPinRoutes } from "../chat/pins/pin-route-writes";
import { reclaimPinWriteLeases } from "../lib/account-moves";
import { ADMIN } from "../env";
import { dropMergeGeneration, dropPinsLeft, firstTableWithGuestRows, mergeGenerationCurrent, onGuestShard } from "../lib/account-merge";
import { patchBetterAuthRow } from "../lib/better-auth-dates";
import { authLogger } from "../lib/logger";
import { noteShardActivity } from "../lib/shard-housekeeping";
import { deleteShardRoute, deleteShardRoutesOf } from "../lib/shard-routes";
import { dropPushDevicesOf } from "../notifications/push-device-writes";

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
        await patchBetterAuthRow(ctx.db, "user", user, { role: "admin" });
    }
});

/** Cascade-delete everything keyed to a user that better-auth does not own. */
export const cascadeDeleteUser = internalMutation.input({ userId: v.id("user") }).mutation(async ({ args, ctx }) => {
    await cascadeDelete(ctx, args.userId);
});

const cascadeDelete = async (ctx: MutationCtx, user: Id<"user">): Promise<void> => {
    const args = { userId: user };

    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (settings) {
        await ctx.db.delete("userSettings", settings._id);
    }

    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", args.userId))
        .first();

    if (preferences) {
        await ctx.db.delete("aiUserPreferences", preferences._id);
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
        await ctx.db.delete("session", row._id);
    }

    for (const row of accounts) {
        await ctx.db.delete("account", row._id);
    }

    for (const row of memberships) {
        await ctx.db.delete("member", row._id);
    }

    const twoFactorDocument = await ctx.db.twoFactor.findFirst({ where: { userId: args.userId as Id<"user"> } });

    if (twoFactorDocument) {
        await ctx.db.delete("twoFactor", twoFactorDocument._id);
    }

    const { page: passkeys } = await ctx.db.passkey.findMany({ where: { userId: args.userId as string } });

    for (const row of passkeys) {
        await ctx.db.delete("passkey", row._id);
    }

    // `.global()` pointers at this user's shard: webhook/public-link routes and
    // the housekeeping census.
    await deleteShardRoutesOf(ctx, args.userId);

    // `.global()` phone push rows, through the notifications module's own write surface: a guest's phone may have
    // registered up to the moment its account goes.
    await dropPushDevicesOf(ctx.db, args.userId);
};

/**
 * Delete a guest whose rows have been moved to the account it converted to, the way the anonymous plugin deletes it
 * when the conversion completes in the guest's own browser. The last step of `lib/account-merge.ts#runGuestMerge`,
 * run on the guest's shard. Never a real account: one is left alone. A guest whose `user` row is already gone (the
 * anonymous plugin deletes it in the sign-up request that queues the merge) is ended all the same once its shard is
 * empty, its generation and pins-left signal dropped; a second run then finds nothing left to drop. A guest still named by a thread follow (one written after the merge read its
 * last page) is kept and `followsRemain` is set, and one still named by a shared pin route (a pin made after the merge's
 * pin step) is kept with `pinsRemain`, and one whose shard still holds a row (written to a table after the merge cleared
 * it) with `rowsRemain` naming the first such table, so the merge moves the row first and tries again. A grant or grant revision still naming the guest (one
 * written after the merge's `global` step) keeps it with `grantsRemain`, and the merge runs that step again. A merge run whose
 * lease generation is no longer the newest this shard has seen deletes nothing (`fenced`). On a shard that is not the
 * guest's own (development's `SHARD_ROUTING=off` runs every user on `__root__`), the merge moved none of its rows, so the
 * guest is kept with them (`sharedShard`). Once the guest is ended, its `merged-guest` mark goes too, so no route names
 * it after the merge; a grant written under the guest from then on finds no account and is refused.
 */
export const deleteMergedGuest = internalMutation
    .input({ generation: v.number(), sharedStore: v.optional(v.boolean()), userId: v.string() })
    .output(
        v.object({
            deleted: v.boolean(),
            fenced: v.optional(v.boolean()),
            followsRemain: v.optional(v.boolean()),
            grantsRemain: v.optional(v.boolean()),
            leasesRemain: v.optional(v.boolean()),
            pinsRemain: v.optional(v.boolean()),
            rowsRemain: v.optional(v.string()),
            sharedShard: v.optional(v.boolean()),
        }),
    )
    .mutation(async ({ args, ctx }) => {
        const guestId = ctx.db.asId("user", args.userId);

        // Before the generation: a merge on a shared store writes none (`noteMergeGeneration`), and must hear why it stops.
        if (!onGuestShard(guestId)) {
            authLogger.warn(`[auth] kept guest ${guestId}: its shard serves other users too, so the merge moved none of its rows`);

            return { deleted: false, sharedShard: true };
        }

        if (!(await mergeGenerationCurrent(ctx.db, args.userId, args.generation))) {
            return { deleted: false, fenced: true };
        }

        // Primary: a replica that has not seen the guest yet would pass as its deletion, and the guest would stay.
        const user = (await ctx.db.user.findFirst({ consistency: "primary", where: { _id: guestId } })) as {
            _id: Id<"user">;
            isAnonymous?: boolean | null;
        } | null;

        // A real account is never deleted here. A missing row is the anonymous plugin's deletion at sign-up: the merge
        // still empties the guest's shard, and this step still ends it, so no row and no generation is left behind.
        if (user !== null && user.isAnonymous !== true) {
            return { deleted: false };
        }

        if (await guestHasFollowRows(ctx.db, guestId)) {
            return { deleted: false, followsRemain: true };
        }

        // A pin the guest made on another owner's thread after the merge's pin step: its route still names the guest.
        if (await guestHasPinRoutes(ctx.db, guestId)) {
            return { deleted: false, pinsRemain: true };
        }

        // A grant or a count still under the guest: the merge's `global` step moves it first.
        if (await guestHoldsGrantRows(ctx, guestId)) {
            return { deleted: false, grantsRemain: true };
        }

        const rowsRemain = await firstTableWithGuestRows(ctx, guestId, args.sharedStore === true);

        if (rowsRemain !== null) {
            return { deleted: false, rowsRemain };
        }

        // Pin-write lease rows still name the guest: a batch goes now, and the merge calls again while any remains. The merge has waited
        // for every live lease and admits none now, since the guest is marked, so each row left is expired.
        if (await reclaimPinWriteLeases(ctx, args.userId)) {
            return { deleted: false, leasesRemain: true };
        }

        await cascadeDelete(ctx, guestId);
        // Its `global` step dropped this already; a guest gone takes its shard's pins-left signal with it in any case.
        await dropPinsLeft(ctx.db, guestId);
        // Never lapses while the merge is unfinished; with the guest gone, nothing is left for it to fence.
        await dropMergeGeneration(ctx.db, guestId);

        if (user !== null) {
            await ctx.db.delete("user", user._id);
        }

        // The mark goes last, once the guest is ended: a grant written under the guest from here on finds no account and
        // is refused (`agent/sharing.ts#insertThreadAccess`), as it found the mark until now.
        await deleteShardRoute(ctx, "merged-guest", args.userId);

        return { deleted: user !== null };
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
        await ctx.db.delete("user", userDocId);

        return null;
    });
