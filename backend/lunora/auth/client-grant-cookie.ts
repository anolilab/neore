/**
 * `POST /api/auth/client-grant/cookie` — finishes the native shell's
 * system-browser sign-in by turning a one-time code into a session COOKIE.
 *
 * The native shell (`apps/native`) cannot use Google sign-in inside its webview
 * (Google refuses embedded webviews), so it runs the extension grant from
 * `extension-grant.ts` in the system browser with the redirect URI
 * `neore://auth/callback` and receives the code back through the OS. The
 * extension keeps its session token and trades it for JWTs; the shell cannot —
 * its webview IS the web app, and the web app authenticates with better-auth's
 * signed session cookie on the app origin. Only better-auth can sign that
 * cookie, so the exchange runs here, as a better-auth endpoint, reached through
 * the app's `/api/auth/*` proxy so the cookie lands on the app origin.
 *
 * The exchange itself is `exchangeExtensionCode`, unchanged: single-use code,
 * one-minute expiry, redirect URI bound at issue, PKCE S256 verifier, a replay
 * or any mismatch burns the code. On top of that this endpoint accepts ONLY the
 * native redirect URI, so a Firefox-extension code can never become a cookie.
 *
 * Login CSRF — a hostile page making the victim's browser adopt the ATTACKER'S
 * session — needs a live code plus its verifier, which only the process that
 * started the flow holds; the page cannot mint one for someone else's browser.
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";

import { NATIVE_REDIRECT_URI } from "../lib/extension-origins";
import { createExtensionGrantStore, exchangeExtensionCode, ExtensionGrantError } from "./extension-grant";

const bodySchema = z.object({
    code: z.string().max(256),
    codeVerifier: z.string().max(256),
    redirectUri: z.string().max(256),
});

/** `ExtensionGrantError#status` → the status name better-auth's `ctx.error` takes. */
const STATUS_NAMES = { 400: "BAD_REQUEST", 401: "UNAUTHORIZED", 403: "FORBIDDEN" } as const;

type SessionCookieArgument = Parameters<typeof setSessionCookie>[1];

export const clientGrantCookie = () =>
    ({
        endpoints: {
            exchangeClientGrantForCookie: createAuthEndpoint(
                "/client-grant/cookie",
                {
                    body: bodySchema,
                    method: "POST",
                },
                async (ctx) => {
                    const { code, codeVerifier, redirectUri } = ctx.body;

                    if (redirectUri !== NATIVE_REDIRECT_URI) {
                        throw ctx.error("BAD_REQUEST", { code: "invalid_request", message: "Only the native app can sign in this way." });
                    }

                    // `createExtensionGrantStore` reads `$context` as a promise of
                    // better-auth's context — which this endpoint already holds.
                    const store = createExtensionGrantStore({ $context: Promise.resolve(ctx.context), api: {} });

                    try {
                        const { token, user } = await exchangeExtensionCode(store, {
                            code,
                            codeVerifier,
                            ipAddress: ctx.request?.headers.get("cf-connecting-ip") ?? undefined,
                            redirectUri,
                            userAgent: ctx.request?.headers.get("user-agent") ?? undefined,
                        });
                        const session = await ctx.context.internalAdapter.findSession(token);

                        if (!session) {
                            throw new ExtensionGrantError("invalid_grant", "The session could not be created.");
                        }

                        await setSessionCookie(ctx, session as SessionCookieArgument);

                        return ctx.json({ user });
                    } catch (error) {
                        if (error instanceof ExtensionGrantError) {
                            throw ctx.error(STATUS_NAMES[error.status], { code: error.code, message: error.message });
                        }

                        throw error;
                    }
                },
            ),
        },
        id: "client-grant-cookie",
    }) satisfies BetterAuthPlugin;
