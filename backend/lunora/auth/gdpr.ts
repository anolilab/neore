/**
 * Erasure of the auth tables a deleted account owns, on the account-deletion
 * workflow's shard (`gdpr/steps/`).
 *
 * Plain functions over the caller's `ctx`, so each write stays in the caller's
 * transaction. The GDPR steps call them and write no auth table themselves.
 * Every delete uses the row's own typed `_id`: a cast to `Id<TableName>` would
 * make the advisor read it as a write to every table.
 */
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { BATCH, deleteOneByOne, full, type BatchResult } from "../gdpr/batch";
import { DELETED_USER_MARKER } from "../gdpr/constants";

/** Every session of the user (`session.userId` is indexed). */
export const deleteSessionsOf = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const sessions = await ctx.db.session.findMany({ where: { userId: userId as Id<"user"> } }).then((result) => result.page);

    for (const row of sessions) {
        await ctx.db.delete(row._id);
    }
};

/** Every linked sign-in account of the user (`account.userId` is indexed). */
export const deleteAccountsOf = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const accounts = await ctx.db.account.findMany({ where: { userId: userId as Id<"user"> } }).then((result) => result.page);

    for (const row of accounts) {
        await ctx.db.delete(row._id);
    }
};

/** The user's settings and AI preferences rows. */
export const deleteUserSettingRows = async (ctx: MutationCtx, userId: string): Promise<void> => {
    const [settings, aiPreferences] = await Promise.all([
        ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect(),
        ctx.db
            .query("aiUserPreferences")
            .withIndex("by_userId", (q) => q.eq("userId", userId))
            .collect(),
    ]);

    // Audited tables: one delete at a time (`gdpr/batch.ts`).
    await deleteOneByOne(ctx, [...settings, ...aiPreferences]);
};

/**
 * Keep the credit ledger, drop the owner: rewrite up to one batch of the user's
 * `gatewayUsageDeductions` to {@link DELETED_USER_MARKER}. It terminates because a
 * rewritten row stops matching.
 */
export const anonymiseGatewayUsage = async (ctx: MutationCtx, userId: string): Promise<BatchResult> => {
    const rows = await ctx.db
        .query("gatewayUsageDeductions")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .take(BATCH);

    await Promise.all(rows.map((row) => ctx.db.patch(row._id, { userId: DELETED_USER_MARKER })));

    return { hasMore: full(rows) };
};

/**
 * One batch of each identity row of the user that {@link deleteIdentityRows}
 * removes, read before any delete. Invitations are matched by the normalised
 * email, and only when there is one.
 */
export const readIdentityRows = async (ctx: MutationCtx, { userEmail, userId }: { userEmail: string; userId: string }) => {
    const id = userId as Id<"user">;
    const email = userEmail.trim().toLowerCase();

    const [twoFactors, passkeys, members, memberCredits, teamMembers, apiKeys, invitations, signUpInvitations] = await Promise.all([
        ctx.db.twoFactor.findMany({ limit: BATCH, where: { userId: id } }).then((result) => result.page),
        ctx.db.passkey.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
        ctx.db.member.findMany({ limit: BATCH, where: { userId: id } }).then((result) => result.page),
        ctx.db.memberCredits.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
        ctx.db.teamMember.findMany({ limit: BATCH, where: { userId } }).then((result) => result.page),
        ctx.db.apikey.findMany({ limit: BATCH, where: { referenceId: userId } }).then((result) => result.page),
        email ? ctx.db.invitation.findMany({ limit: BATCH, where: { email } }).then((result) => result.page) : Promise.resolve([]),
        email ? ctx.db.signUpInvitation.findMany({ limit: BATCH, where: { email } }).then((result) => result.page) : Promise.resolve([]),
    ]);

    return { apiKeys, invitations, members, memberCredits, passkeys, signUpInvitations, teamMembers, twoFactors };
};

export type IdentityRows = Awaited<ReturnType<typeof readIdentityRows>>;

/** Deletes the rows {@link readIdentityRows} returned, one at a time (every delete fires the audit triggers). */
export const deleteIdentityRows = async (ctx: MutationCtx, rows: IdentityRows): Promise<void> => {
    for (const row of rows.twoFactors) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.passkeys) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.members) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.memberCredits) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.teamMembers) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.apiKeys) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.invitations) {
        await ctx.db.delete(row._id);
    }

    for (const row of rows.signUpInvitations) {
        await ctx.db.delete(row._id);
    }
};

/** The `user` row itself, last, once nothing else points at it. */
export const deleteUserRecord = async (ctx: MutationCtx, userId: Id<"user">): Promise<void> => {
    const user = await ctx.db.user.findFirst({ where: { _id: userId } });

    if (user) {
        await ctx.db.delete(userId);
    }
};
