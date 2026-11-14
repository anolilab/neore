/**
 * No new credential for an account while an admin is acting as it.
 *
 * Every impersonation guard reads the session's `impersonatedBy` mark. A credential made during impersonation would
 * reach the account later under an identity that has no such mark, so it would pass all of those guards. That
 * covers an API key (`DELETE /api/v1/threads/{id}` would get past the thread guards), a passkey or a new password
 * (a later sign-in starts a session with no mark), and a new email address or linked social account (each leads to
 * one). The scoped-key action `auth_api_keys.createScopedApiKey` refuses on its own; this covers better-auth's
 * own routes, including the plain `/api-key/create` the client SDK can call.
 *
 * The CLI device flow and the extension grant refuse an impersonated session on their own (`cli-device-auth.ts`,
 * `extension-grant.ts`).
 */
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";

export const CREDENTIAL_WHILE_IMPERSONATING = "CREDENTIAL_WHILE_IMPERSONATING";

/** better-auth routes that give the account a credential or a way to one. */
const CREDENTIAL_PATHS: ReadonlySet<string> = new Set([
    "/api-key/create",
    "/change-email",
    "/change-password",
    // emailOTP's change-email routes: not enabled today, listed so turning them on cannot open a gap.
    "/email-otp/change-email",
    "/email-otp/request-email-change",
    "/link-social",
    "/passkey/generate-register-options",
    "/passkey/verify-registration",
]);

export const impersonationCredentialGuard = () =>
    ({
        hooks: {
            before: [
                {
                    handler: createAuthMiddleware(async (ctx) => {
                        const session = await getSessionFromCtx(ctx);

                        if ((session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy) {
                            throw new APIError("FORBIDDEN", {
                                code: CREDENTIAL_WHILE_IMPERSONATING,
                                message: "Sign in as yourself to add a key, passkey, password or sign-in method.",
                            });
                        }
                    }),
                    matcher: (ctx) => CREDENTIAL_PATHS.has(ctx.path ?? ""),
                },
            ],
        },
        id: "neore-impersonation-credential-guard",
    }) satisfies BetterAuthPlugin;
