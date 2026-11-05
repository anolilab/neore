/**
 * A guest's data follows them into their account even when they verify the address in another browser.
 *
 * Converting a guest is a password sign-up made with the guest's session. The anonymous plugin hands the guest's rows
 * over (`onLinkAccount`) only once a session is issued while the guest's cookie is still in the request. Where email
 * verification is required, sign-up issues no session: it comes from the verification link, and a link opened in
 * another browser or device carries no guest cookie, so the guest's rows would stay behind.
 *
 * So the sign-up records which guest the new account came from, server-side, under better-auth's verification store,
 * and the first session the account gets (from the link, or a later sign-in) finishes the link. The guest id is only
 * ever read from the request's resolved session, never from the body or the query. The record goes only once the move
 * is queued, so a failed hand-over is retried at the next sign-in; an unverified sign-in, which mails a new link,
 * renews it. Verifying in the same browser also runs `onLinkAccount`; both queue the same move, which is safe to run
 * twice (`lib/account-merge.ts`).
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

import { authLogger } from "../lib/logger";

/** How long a recorded guest waits for its account's first session; renewed by every unverified sign-in. */
export const PENDING_GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pendingIdentifier = (userId: string): string => `guest-conversion:${userId}`;

/** Where an account gets a session, or (unverified) is mailed a new link. */
const SESSION_PATHS = new Set(["/sign-in/email", "/verify-email"]);

interface SignUpReturn {
    token?: string | null;
    user?: { id?: string };
}

type InternalAdapter = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]["context"]["internalAdapter"];

const remember = async (adapter: InternalAdapter, userId: string, guestId: string): Promise<void> => {
    await adapter.deleteVerificationByIdentifier(pendingIdentifier(userId));
    await adapter.createVerificationValue({
        expiresAt: new Date(Date.now() + PENDING_GUEST_LINK_TTL_MS),
        identifier: pendingIdentifier(userId),
        value: guestId,
    });
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

                        if (guest?.isAnonymous === true) {
                            await remember(ctx.context.internalAdapter, userId, guest.id);
                        }
                    }),
                    matcher: (ctx) => ctx.path === "/sign-up/email",
                },
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const adapter = ctx.context.internalAdapter;
                        const sessionUserId = ctx.context.newSession?.user.id;

                        if (!sessionUserId) {
                            // No session: an unverified sign-in, which mails a new link. Keep the guest for that link.
                            const email = (ctx.body as { email?: unknown } | undefined)?.email;
                            const account = typeof email === "string" ? await adapter.findUserByEmail(email) : null;
                            const pending =
                                account && !account.user.emailVerified ? await adapter.findVerificationValue(pendingIdentifier(account.user.id)) : null;

                            if (account && pending) {
                                await remember(adapter, account.user.id, pending.value);
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
                    }),
                    matcher: (ctx) => SESSION_PATHS.has(ctx.path ?? ""),
                },
            ],
        },
        id: "neore-guest-conversion",
    }) satisfies BetterAuthPlugin;
