/**
 * Admin surface for sign-up invitations.
 *
 * `@lunora/auth` ships the invitation lifecycle but deliberately no HTTP
 * endpoint for it — "who counts as an administrator is your application's
 * question". These are that answer: `adminAction`, which is `authAction` plus a
 * `role === "admin"` check, the same gate every other administrative procedure
 * here uses.
 *
 * Delivery is ours too — nothing in the plugin sends mail. `createInvitation`
 * returns the sign-up URL with the token already in it, and the operator sends
 * it. The plaintext token is shown ONCE and never stored (the row keeps only a
 * SHA-256), so a link that is lost is reissued, not recovered.
 */
import { createSignUpInvitation, listSignUpInvitations, pruneSignUpInvitations, revokeSignUpInvitation } from "@lunora/auth";
import { v } from "lunorash/server";

import { adminAction, rateLimit } from "../lib/crpc";
import { ADMIN, SITE_URL } from "../env";
import { getAuth } from "../auth";
import { MAX_LENGTH } from "../lib/validators";

/** A week, matching the plugin's own default. */
const DEFAULT_EXPIRY_SECONDS = 7 * 24 * 60 * 60;

/** How many expired rows one prune pass clears; the sweep is incremental by design. */
const PRUNE_LIMIT = 500;

/** Trailing slash on `SITE_URL`, stripped so the invite link has exactly one. */
const TRAILING_SLASH = /\/$/;

/** The one shape an invite link takes; the token travels in it and nowhere else. */
const signUpUrlFor = (token: string): string => `${SITE_URL.replace(TRAILING_SLASH, "")}/auth/sign-up?invite=${encodeURIComponent(token)}`;

const vInvitation = v.object({
    acceptedAt: v.union(v.number(), v.null()),
    createdAt: v.number(),
    email: v.string(),
    expiresAt: v.number(),
    id: v.string(),
    invitedBy: v.union(v.string(), v.null()),
});

/** `Date` on the wire is a number here, like every other timestamp in this schema. */
const toMillis = (value: Date | null): null | number => (value === null ? null : value.getTime());

/**
 * Invite `email`, or refresh an existing invitation for it.
 *
 * Re-inviting replaces the token, so the previous link stops working — that is
 * also how a seat is re-opened after deleting the account that took it.
 */
export const createInvitation = adminAction
    .use(rateLimit("admin/write"))
    .input({
        email: v.string().check((value) => value.trim() !== "", { message: "email is required" }),
        expiresInSeconds: v.optional(v.number()),
    })
    .output(v.object({ email: v.string(), expiresAt: v.number(), signUpUrl: v.string() }))
    .action(async ({ args, ctx }) => {
        const invitation = await createSignUpInvitation(getAuth(), {
            email: args.email,
            expiresInSeconds: args.expiresInSeconds ?? DEFAULT_EXPIRY_SECONDS,
            // Attribution only — the gate never reads it.
            invitedBy: ctx.user.userId,
        });

        // The token travels in the link and nowhere else; it is never logged.
        const signUpUrl = signUpUrlFor(invitation.token);

        ctx.log.event("auth.create_invitation", { hasCustomExpiry: args.expiresInSeconds !== undefined, invitedBy: ctx.user.userId });

        return { email: invitation.email, expiresAt: invitation.expiresAt.getTime(), signUpUrl };
    });

/** The most recent invitations, newest first. `pendingOnly` drops spent and expired ones. */
export const listInvitations = adminAction
    .use(rateLimit("admin/read"))
    .input({ pendingOnly: v.optional(v.boolean()) })
    .output(v.array(vInvitation))
    .action(async ({ args, ctx }) => {
        const invitations = await listSignUpInvitations(getAuth(), { pendingOnly: args.pendingOnly ?? false });

        ctx.log.event("auth.list_invitations", { count: invitations.length, pendingOnly: args.pendingOnly ?? false });

        return invitations.map((invitation) => {
            return {
                acceptedAt: toMillis(invitation.acceptedAt),
                createdAt: invitation.createdAt.getTime(),
                email: invitation.email,
                expiresAt: invitation.expiresAt.getTime(),
                id: invitation.id,
                invitedBy: invitation.invitedBy,
            };
        });
    });

/**
 * Withdraw the invitation for `email`.
 *
 * Not retroactive: an account already created keeps working, and removing it is
 * `AuthAdmin.removeUser`'s job. Nor is it atomic against a sign-up in flight —
 * better-auth does not wrap the hook and the insert in one transaction, so a
 * revoke landing between them lets that one account through.
 */
export const revokeInvitation = adminAction
    .use(rateLimit("admin/write"))
    .input({ email: v.string().max(MAX_LENGTH.short) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await revokeSignUpInvitation(getAuth(), { email: args.email });

        ctx.log.event("auth.revoke_invitation", { revoked: true });

        return null;
    });

/**
 * Delete invitations that expired unused, and report how many went.
 *
 * Only the dead ones — a spent invitation is the record of who was let in.
 * Incremental, so a backlog larger than {@link PRUNE_LIMIT} takes several passes.
 */
export const pruneInvitations = adminAction
    .use(rateLimit("admin/write"))
    .input({})
    .output(v.number())
    .action(async ({ ctx }) => {
        const pruned = await pruneSignUpInvitations(getAuth(), { limit: PRUNE_LIMIT });

        ctx.log.event("auth.prune_invitations", { pruned });

        return pruned;
    });

/** Why an `ADMIN` address did or did not get a fresh link from {@link seedAdminInvitationLinks}. */
export type SeedOutcome = "issued" | "pending" | "registered";

export interface SeededInvitation {
    email: string;
    /** Only on `issued`: a pending link cannot be shown again, its token is stored hashed. */
    signUpUrl?: string;
    status: SeedOutcome;
}

/** The addresses in `ADMIN`, lowercased and de-duplicated. */
export const parseAdminEmails = (value: string): string[] => [
    ...new Set(
        value
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean),
    ),
];

/**
 * Invite every address in `ADMIN`, so a fresh deployment can be opened.
 *
 * Invite-only registration is a bootstrap deadlock otherwise: `createInvitation`
 * needs an admin, an admin needs an account, and an account needs an invitation.
 * `allowFirstUser` is upstream's answer and a bad one here — it races two
 * concurrent sign-ups and leaves the gap between deploy and the owner signing up
 * open to whoever finds the URL.
 *
 * Idempotent: an address whose invitation was already spent is `registered`, one
 * with an unexpired unspent invitation is `pending`, and neither is touched —
 * re-inviting would mint a new token and silently kill the link the operator
 * already sent (or, for a spent one, clear `acceptedAt`). Only a missing or
 * expired invitation is `issued`. `reissue` re-mints the pending ones, for a
 * link that was lost; the token is stored hashed, so that is the only recovery.
 *
 * The links are returned rather than logged, and go nowhere else. The operator
 * entry point is `POST /admin/seed-invitations` (`seed-invitations-http.ts`) —
 * `lunora run` cannot reach an internal function.
 */
export const seedAdminInvitationLinks = async (options: { reissue?: boolean } = {}): Promise<SeededInvitation[]> => {
    const emails = parseAdminEmails(ADMIN);

    if (emails.length === 0) {
        throw new Error("ADMIN is empty — set it to the comma-separated addresses that should be able to register");
    }

    const auth = getAuth();
    const now = Date.now();
    const invitations = await listSignUpInvitations(auth);
    const existing = new Map(invitations.map((invitation) => [invitation.email, invitation]));
    const seeded: SeededInvitation[] = [];

    for (const email of emails) {
        const current = existing.get(email);

        if (current?.acceptedAt) {
            seeded.push({ email, status: "registered" });
            continue;
        }

        if (current && current.expiresAt.getTime() > now && !options.reissue) {
            seeded.push({ email, status: "pending" });
            continue;
        }

        // Sequential on purpose: `email` is unique and each call writes the
        // same table, so a parallel map buys nothing and makes a partial
        // failure harder to read.
        const invitation = await createSignUpInvitation(auth, { email, expiresInSeconds: DEFAULT_EXPIRY_SECONDS, invitedBy: "seed" });

        seeded.push({ email: invitation.email, signUpUrl: signUpUrlFor(invitation.token), status: "issued" });
    }

    return seeded;
};
