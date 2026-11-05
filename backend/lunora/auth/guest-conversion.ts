/**
 * A guest's data follows them into their account even when they verify the address in another browser.
 *
 * Converting a guest is a password sign-up made with the guest's session. The anonymous plugin hands the guest's rows
 * over (`onLinkAccount`) only once a session is issued while the guest's cookie is still in the request. Where email
 * verification is required, sign-up issues no session: it comes from the verification link, and a link opened in
 * another browser or device carries no guest cookie, so the guest's rows would stay behind.
 *
 * So the sign-up records which guest the new account came from, server-side, under better-auth's verification store,
 * and the account's first password sign-in, or the verification link, finishes the link (see `HAND_OVER_PATHS`). The guest id is only
 * ever read from the request's resolved session, never from the body or the query. The record goes only once the move
 * is queued, so a failed hand-over is retried at the next sign-in; an unverified sign-in, which mails a new link,
 * renews it in place. If the record cannot be written at sign-up (or the account's password cannot be read), there is
 * no hand-over at all: the data stays with the guest and the failure is logged. Moving it right away would skip the
 * password check below. The record
 * also holds a digest of the sign-up's password hash ({@link credentialFingerprint}); a hand-over happens only while the
 * account still has that password. Someone can sign up as a guest with another person's address; when the real owner
 * resets the password and verifies, the digest no longer matches and the stranger's data stays out of their account.
 * That holds for every way a password is replaced, including ones added later, which hooks on request paths would
 * miss. Verifying in
 * the same browser also runs `onLinkAccount`; every path queues the same move, which is safe to run twice
 * (`lib/account-merge.ts`).
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import { sha256Hex, timingSafeEqual } from "../lib/crypto";
import { authLogger } from "../lib/logger";

/** How long a recorded guest waits for its account's first session; renewed by every unverified sign-in. */
export const PENDING_GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pendingIdentifier = (userId: string): string => `guest-conversion:${userId}`;

/** The one refused request that still proves the password, and so mails a new link and renews the pending guest. */
const PASSWORD_SIGN_IN_PATH = "/sign-in/email";

/**
 * The only sessions that finish a hand-over: the sign-up's own password, or the link mailed for that sign-up. A magic
 * link, email code, passkey, social provider or admin impersonation proves the account's address or an operator, not
 * whoever signed up with the guest's session, so a sign-up made with someone else's address could otherwise push its
 * guest data into the real owner's account at their next sign-in. A record left pending waits for one of these two.
 */
const HAND_OVER_PATHS = new Set(["/verify-email", PASSWORD_SIGN_IN_PATH]);

interface SignUpReturn {
    token?: string | null;
    user?: { id?: string };
}

const pendingExpiry = (): Date => new Date(Date.now() + PENDING_GUEST_LINK_TTL_MS);

type ConversionAdapter = {
    findAccounts: (userId: string) => Promise<{ password?: string | null; providerId: string }[]>;
};

/**
 * Which password the account holds, as a digest of its stored hash. A hash is salted, so any change of password (a
 * reset by the address's owner, a change, an admin setting one, a path added later) gives a new digest, even to the
 * same password. `undefined` without a password.
 */
const credentialFingerprint = async (adapter: ConversionAdapter, userId: string): Promise<string | undefined> => {
    const accounts = await adapter.findAccounts(userId);
    const hash = accounts.find((account) => account.providerId === "credential")?.password;

    return hash ? await sha256Hex(hash) : undefined;
};

/** What a record holds: the guest, and the sign-up's password as {@link credentialFingerprint} saw it. */
interface PendingGuest {
    credential: string;
    guest: string;
}

/** A record written before it carried the credential (a bare guest id) reads as `undefined`: never handed over. */
const parsePending = (value: string): PendingGuest | undefined => {
    try {
        const parsed = JSON.parse(value) as Partial<PendingGuest> | null;

        return typeof parsed?.guest === "string" && typeof parsed.credential === "string" ? { credential: parsed.credential, guest: parsed.guest } : undefined;
    } catch {
        return undefined;
    }
};

type HandOverContext = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Finish a recorded guest's hand-over once its account has a session from {@link HAND_OVER_PATHS}, or renew the
 * record when an unverified sign-in mailed a new link. Throws on a storage error; the caller logs it.
 */
const handOver = async (ctx: HandOverContext, onGuestConverted: (guestId: string, userId: string) => Promise<void>): Promise<void> => {
    const adapter = ctx.context.internalAdapter;
    const sessionUserId = ctx.context.newSession?.user.id;

    if (!sessionUserId) {
        if (ctx.path !== PASSWORD_SIGN_IN_PATH) {
            return;
        }

        // No session. Only `EMAIL_NOT_VERIFIED` means the password was right and a new link went out:
        // keep the guest for that link. Any other failure (a wrong password) renews nothing.
        const refusal = ctx.context.returned as { body?: { code?: string } } | undefined;
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        const account = refusal?.body?.code === "EMAIL_NOT_VERIFIED" && typeof email === "string" ? await adapter.findUserByEmail(email) : null;
        const pending = account && !account.user.emailVerified ? await adapter.findVerificationValue(pendingIdentifier(account.user.id)) : null;

        if (account && pending) {
            try {
                // One in-place write: a failed renewal leaves the record and its expiry as they were.
                await adapter.updateVerificationByIdentifier(pendingIdentifier(account.user.id), { expiresAt: pendingExpiry() });
            } catch (error) {
                authLogger.error(`[auth] renewing the guest record for ${account.user.id} failed:`, error);
            }
        }

        return;
    }

    const pending = await adapter.findVerificationValue(pendingIdentifier(sessionUserId));

    if (!pending || pending.expiresAt.getTime() < Date.now()) {
        return;
    }

    const recorded = parsePending(pending.value);
    const credential = await credentialFingerprint(adapter, sessionUserId);

    // The password is no longer the one the guest signed up with (the address's owner reset or changed it), or the
    // record predates the check: whoever signs in now did not sign up with the guest's session. No hand-over.
    if (!recorded || !credential || !timingSafeEqual(recorded.credential, credential)) {
        authLogger.warn(`[auth] the guest record for ${sessionUserId} does not match the account's password; dropped without a hand-over`);
        await adapter.deleteVerificationByIdentifier(pendingIdentifier(sessionUserId));

        return;
    }

    // Only a guest that still exists, and is still a guest, hands its rows over.
    const guest = (await adapter.findUserById(recorded.guest)) as { isAnonymous?: boolean | null } | null;

    if (guest?.isAnonymous === true) {
        try {
            await onGuestConverted(recorded.guest, sessionUserId);
        } catch (error) {
            // Kept, so the next sign-in tries again; the session itself must not fail.
            authLogger.error(`[auth] handing guest ${recorded.guest} over to ${sessionUserId} failed:`, error);

            return;
        }

        // The guest's browser would otherwise keep using a guest whose data has moved; the merge deletes the guest.
        try {
            await adapter.deleteUserSessions(recorded.guest);
        } catch (error) {
            authLogger.error(`[auth] ending guest ${recorded.guest}'s sessions failed:`, error);
        }
    }

    await adapter.deleteVerificationByIdentifier(pendingIdentifier(sessionUserId));
};

export const guestConversion = (onGuestConverted: (guestId: string, userId: string) => Promise<void>) =>
    ({
        hooks: {
            after: [
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const returned = ctx.context.returned as SignUpReturn | undefined;
                        const userId = returned?.user?.id;

                        // A session issued at once is linked by the anonymous plugin itself.
                        if (!userId || returned?.token) {
                            return;
                        }

                        const session = await getSessionFromCtx(ctx);
                        const guest = session?.user as { id: string; isAnonymous?: boolean | null } | undefined;

                        if (guest?.isAnonymous !== true) {
                            return;
                        }

                        try {
                            const credential = await credentialFingerprint(ctx.context.internalAdapter, userId);

                            if (!credential) {
                                throw new Error("the new account has no password to bind the record to");
                            }

                            await ctx.context.internalAdapter.createVerificationValue({
                                expiresAt: pendingExpiry(),
                                identifier: pendingIdentifier(userId),
                                value: JSON.stringify({ credential, guest: guest.id } satisfies PendingGuest),
                            });
                        } catch (error) {
                            // No record means no hand-over. Moving the guest now instead would skip the password check
                            // that stops a stranger's guest from landing in an address owner's account; losing the
                            // guest's data is the lesser failure. The sign-up itself still answers.
                            authLogger.error(`[auth] recording guest ${guest.id} for ${userId} failed; its data stays with the guest:`, error);
                        }
                    }),
                    matcher: (ctx) => ctx.path === "/sign-up/email",
                },
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        try {
                            await handOver(ctx, onGuestConverted);
                        } catch (error) {
                            // The sign-in or verification has already succeeded or been refused on its own terms; a
                            // storage error here must not turn it into a 500. The record stays for the next sign-in.
                            authLogger.error(`[auth] guest hand-over on ${String(ctx.path)} failed; the record is kept:`, error);
                        }
                    }),
                    matcher: (ctx) => HAND_OVER_PATHS.has(ctx.path ?? ""),
                },
            ],
        },
        id: "neore-guest-conversion",
    }) satisfies BetterAuthPlugin;
