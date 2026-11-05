/**
 * A guest's data follows them into their account even when they verify the address in another browser.
 *
 * Converting a guest is a password sign-up made with the guest's session. The anonymous plugin hands the guest's rows
 * over (`onLinkAccount`) only once a session is issued while the guest's cookie is still in the request. Where email
 * verification is required, sign-up issues no session: it comes from the verification link, and a link opened in
 * another browser or device carries no guest cookie, so the guest's rows would stay behind.
 *
 * So the sign-up records which guest the new account came from, server-side, under better-auth's verification store,
 * and the verification that signs the account in finishes the link. The guest id is only ever read from the
 * request's resolved session, never from the body or the query. Verifying in the same browser also runs
 * `onLinkAccount`; both hand over the same move, which is safe to run twice (`lib/account-merge.ts`).
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

/** Long enough for a link sent again at a later sign-in (`sendOnSignIn`), not only the first one. */
export const PENDING_GUEST_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const pendingIdentifier = (userId: string): string => `guest-conversion:${userId}`;

interface SignUpReturn {
    token?: string | null;
    user?: { id?: string };
}

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

                        await ctx.context.internalAdapter.createVerificationValue({
                            expiresAt: new Date(Date.now() + PENDING_GUEST_LINK_TTL_MS),
                            identifier: pendingIdentifier(userId),
                            value: guest.id,
                        });
                    }),
                    matcher: (ctx) => ctx.path === "/sign-up/email",
                },
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const userId = ctx.context.newSession?.user.id;

                        if (!userId) {
                            return;
                        }

                        const identifier = pendingIdentifier(userId);
                        const pending = await ctx.context.internalAdapter.findVerificationValue(identifier);

                        if (!pending) {
                            return;
                        }

                        await ctx.context.internalAdapter.deleteVerificationByIdentifier(identifier);

                        if (pending.expiresAt.getTime() < Date.now()) {
                            return;
                        }

                        // Only a guest that still exists, and is still a guest, hands its rows over.
                        const guest = (await ctx.context.internalAdapter.findUserById(pending.value)) as { isAnonymous?: boolean | null } | null;

                        if (guest?.isAnonymous === true) {
                            await onGuestConverted(pending.value, userId);
                        }
                    }),
                    matcher: (ctx) => ctx.path === "/verify-email",
                },
            ],
        },
        id: "neore-guest-conversion",
    }) satisfies BetterAuthPlugin;
