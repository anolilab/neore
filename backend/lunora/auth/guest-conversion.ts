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
 * renews it in place. If the record cannot be written at sign-up, the move is queued there and then, while the request
 * still holds the guest's session: the email is now taken, so no later request could rebuild the record. Verifying in
 * the same browser also runs `onLinkAccount`; every path queues the same move, which is safe to run twice
 * (`lib/account-merge.ts`).
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

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
const HAND_OVER_PATHS = new Set([PASSWORD_SIGN_IN_PATH, "/verify-email"]);

interface SignUpReturn {
    token?: string | null;
    user?: { id?: string };
}

const pendingExpiry = (): Date => new Date(Date.now() + PENDING_GUEST_LINK_TTL_MS);

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
                authLogger.error(`[auth] renewing guest ${pending.value} for ${account.user.id} failed:`, error);
            }
        }

        return;
    }

    const pending = await adapter.findVerificationValue(pendingIdentifier(sessionUserId));

    if (!pending || pending.expiresAt.getTime() < Date.now()) {
        return;
    }

    // Only a guest that still exists, and is still a guest, hands its rows over.
    const guest = (await adapter.findUserById(pending.value)) as { isAnonymous?: boolean | null } | null;

    if (guest?.isAnonymous === true) {
        try {
            await onGuestConverted(pending.value, sessionUserId);
        } catch (error) {
            // Kept, so the next sign-in tries again; the session itself must not fail.
            authLogger.error(`[auth] handing guest ${pending.value} over to ${sessionUserId} failed:`, error);

            return;
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
                            await ctx.context.internalAdapter.createVerificationValue({
                                expiresAt: pendingExpiry(),
                                identifier: pendingIdentifier(userId),
                                value: guest.id,
                            });
                        } catch (error) {
                            authLogger.error(`[auth] recording guest ${guest.id} for ${userId} failed; queueing the move now:`, error);

                            try {
                                await onGuestConverted(guest.id, userId);
                            } catch (queueError) {
                                // The account exists already, so the sign-up must still answer; only this log is left.
                                authLogger.error(`[auth] handing guest ${guest.id} over to ${userId} failed:`, queueError);
                            }
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
