/**
 * Which sign-in methods this deployment offers, and the gate on OAuth first
 * sign-in — the two halves of "a provider exists only when it is configured".
 *
 * Every provider beyond email is optional and switched on by its own env vars
 * (`env.ts`): Google, GitHub, Microsoft, one enterprise OIDC provider, and
 * passkeys. The app must not show a button for a provider the backend does not
 * have — the click would end on better-auth's "provider not found" — so it asks
 * `GET /api/auth/sign-in-methods` instead of mirroring the env in `VITE_` vars
 * that could drift from it.
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

/** What the sign-in UI renders. Nothing here is secret: ids, labels and flags. */
export interface SignInMethods {
    /** The enterprise OIDC provider (`genericOAuth`), when configured. */
    oidc: { label: string; providerId: string } | null;
    passkey: boolean;
    /** better-auth social provider ids, in display order. */
    social: string[];
}

/** better-auth's error code for the gate below. */
export const OAUTH_EMAIL_UNVERIFIED = "OAUTH_EMAIL_UNVERIFIED";

export const PASSKEY_REQUIRES_ACCOUNT = "PASSKEY_REQUIRES_ACCOUNT";

/** The passkey plugin's registration endpoints. */
const PASSKEY_REGISTER_PATH = /^\/passkey\/(?:generate-register-options|verify-registration)$/;

/**
 * The creation paths that may produce a user WITHOUT a verified address:
 * email/password sign-up (the invitation link is the proof there, and
 * verification follows) and an admin creating an account. Every other path —
 * OAuth callbacks, `/sign-in/social` with an id token, a plugin added later, a
 * server-side call with no path — must arrive verified. Magic link and email
 * OTP create users verified, so they pass without a listing.
 */
const UNVERIFIED_CREATE_PATH = /^\/(?:sign-up\/email|admin\/create-user)$/;

export const signInMethods = (methods: SignInMethods, options: { inviteOnly: boolean }) =>
    ({
        endpoints: {
            getSignInMethods: createAuthEndpoint("/sign-in-methods", { method: "GET" }, async (ctx) => {
                ctx.setHeader("cache-control", "public, max-age=300");

                return ctx.json(methods);
            }),
        },
        /**
         * No passkeys on a guest. A guest session is real enough for the
         * passkey plugin to register one, but converting the guest creates a
         * NEW user and deletes the guest — the passkey would be left pointing at
         * a user that no longer exists. Register it after signing up.
         */
        hooks: {
            before: [
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const session = await getSessionFromCtx(ctx);

                        if ((session?.user as { isAnonymous?: boolean | null } | undefined)?.isAnonymous === true) {
                            throw new APIError("FORBIDDEN", { code: PASSKEY_REQUIRES_ACCOUNT, message: "Create an account before adding a passkey." });
                        }
                    }),
                    matcher: (ctx) => PASSKEY_REGISTER_PATH.test(ctx.path ?? ""),
                },
            ],
        },
        id: "neore-sign-in-methods",
        /**
         * With invite-only on, an OAuth first sign-in is admitted by EMAIL: the
         * invitation names an address and the provider vouches for it. That is
         * only as good as the vouching. GitHub and Google report verified
         * addresses, but a Microsoft work account or an arbitrary OIDC issuer
         * can carry an address its owner never proved — whoever controls such
         * a tenant could claim someone else's pending invitation. So a new user
         * must arrive with `emailVerified: true` unless it comes through one of
         * the listed `UNVERIFIED_CREATE_PATH`s — fail closed, so a creation
         * path nobody thought of is gated rather than open. Guests are exempt.
         *
         * Only NEW users are gated (the hook is `user.create`); linking or
         * signing in to an existing account is better-auth's own business.
         */
        init: () =>
            options.inviteOnly
                ? {
                      options: {
                          databaseHooks: {
                              user: {
                                  create: {
                                      before: async (user, ctx) => {
                                          if (user.isAnonymous === true || (ctx?.path && UNVERIFIED_CREATE_PATH.test(ctx.path))) {
                                              return;
                                          }

                                          if (user.emailVerified !== true) {
                                              throw new APIError("BAD_REQUEST", {
                                                  code: OAUTH_EMAIL_UNVERIFIED,
                                                  message: "Your sign-in provider did not confirm this email address, so it cannot redeem an invitation.",
                                              });
                                          }
                                      },
                                  },
                              },
                          },
                      },
                  }
                : undefined,
    }) satisfies BetterAuthPlugin;
