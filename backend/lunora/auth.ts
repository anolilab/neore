/**
 * Better Auth integration.
 *
 * Built on Lunora's `createAuth`:
 *
 * - The auth tables live in D1 (`.global()` in `schema.ts`), reached through
 *   `lunoraD1Adapter`. Passing the raw `env.DB` also works, but better-auth then
 *   resolves its Kysely adapter with a runtime `await import(...)` that never
 *   settles under the Cloudflare vite plugin's worker runner — every auth request
 *   hangs in `pnpm dev`. The explicit adapter skips that path.
 * - The lifecycle triggers are better-auth `databaseHooks`. The bodies are verbatim
 *   but now live in `auth/hooks.ts` as internal mutations, because a databaseHook
 *   has no `ctx.db`. They are invoked over a shard client
 *   pinned to `__root__` — where every other read of those rows runs (see the
 *   header of `auth/hooks.ts`).
 * - `buildAuthOptions` takes `env` rather than a request context: `createAuth` runs
 *   once per isolate at worker setup, not per request.
 */
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { createAuth, lunoraD1Adapter } from "@lunora/auth";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { admin, anonymous, captcha, emailOTP, genericOAuth, jwt, magicLink, organization, twoFactor } from "better-auth/plugins";
import { createShardClient } from "lunorash/runtime";

import { internal } from "./_generated/internal";
import type { Id } from "./_generated/dataModel";
import { clientGrantCookie } from "./auth/client-grant-cookie";
import { deletedOrganizationOf, queueOrganizationBillingCancel } from "./billing/gdpr";
import { organizationOfMemberChange, queueSeatSync } from "./billing/seats";
import { adminEmails } from "./auth/hooks";
import { inviteOnly } from "@lunora/auth/plugins";
import { ac, roles } from "./auth/permissions";
import type { SignInMethods } from "./auth/sign-in-methods";
import { signInMethods } from "./auth/sign-in-methods";
import { sendEmailVerification, sendMagicLink, sendOrganizationInvite, sendOTPVerification, sendResetPassword } from "./email/functions";
import {
    AUTH_GITHUB_CLIENT_ID,
    AUTH_GITHUB_CLIENT_SECRET,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    MICROSOFT_CLIENT_ID,
    MICROSOFT_CLIENT_SECRET,
    MICROSOFT_TENANT_ID,
    OIDC_BUTTON_LABEL,
    OIDC_CLIENT_ID,
    OIDC_CLIENT_SECRET,
    OIDC_ISSUER,
    SITE_URL,
    TRUSTED_EXTENSION_ORIGINS,
    SIGNUP_INVITE_ONLY,
    TURNSTILE_SECRET_KEY,
    TURNSTILE_SITE_KEY,
} from "./env";
import { parseOidcIssuer } from "./lib/env-validation";
import { parseTrustedExtensionOrigins } from "./lib/extension-origins";
import { enqueueJob } from "./lib/job-queue";
import { authLogger } from "./lib/logger";
import { API_KEY_PREFIX } from "./public-api/identity";
import { DEFAULT_API_SCOPES } from "./public-api/scopes";
import { INVITATION_EXPIRATION_SECONDS, MEMBERSHIP_LIMIT, ORGANIZATION_LIMIT } from "./lib/constants";
import { routedShardNamespace } from "./lib/shard-namespace";

/** Exact extension origins only; unset or malformed never means "any extension". */
const trustedExtensionOrigins = parseTrustedExtensionOrigins(TRUSTED_EXTENSION_ORIGINS);

/** The enterprise OIDC provider's id — its callback is `/api/auth/callback/oidc`. */
export const OIDC_PROVIDER_ID = "oidc";

/** How long the OIDC discovery fetch may hold auth initialisation. */
const OIDC_DISCOVERY_DEADLINE_MS = 5000;

/**
 * The better-auth social providers, each present only when BOTH halves of its
 * client credentials are set — a provider with an id and no secret would put a
 * button on the page that fails at the token exchange.
 */
const buildSocialProviders = (): NonNullable<BetterAuthOptions["socialProviders"]> => {
    return {
        ...(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && { google: { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET } }),
        ...(AUTH_GITHUB_CLIENT_ID && AUTH_GITHUB_CLIENT_SECRET && { github: { clientId: AUTH_GITHUB_CLIENT_ID, clientSecret: AUTH_GITHUB_CLIENT_SECRET } }),
        ...(MICROSOFT_CLIENT_ID &&
            MICROSOFT_CLIENT_SECRET && {
                microsoft: {
                    clientId: MICROSOFT_CLIENT_ID,
                    clientSecret: MICROSOFT_CLIENT_SECRET,
                    // The profile photo is a Graph fetch on every sign-in with no
                    // deadline we can set; the avatar is not worth a hung callback.
                    disableProfilePhoto: true,
                    tenantId: MICROSOFT_TENANT_ID || "common",
                },
            }),
    };
};

/** `{issuer}/.well-known/openid-configuration`, keeping any path the issuer has (`/realms/acme`). */
const oidcDiscoveryUrl = (issuer: URL): string => new URL(".well-known/openid-configuration", issuer.href.endsWith("/") ? issuer.href : `${issuer.href}/`).href;

let loggedIssuerError: string | undefined;

/**
 * The OIDC discovery URL when the provider is fully configured with a usable
 * issuer, else null. A bad issuer (not a URL, not https) switches off OIDC
 * alone, with one logged error per isolate — never the rest of sign-in.
 */
const resolveOidcDiscoveryUrl = (): string | null => {
    if (!OIDC_ISSUER || !OIDC_CLIENT_ID || !OIDC_CLIENT_SECRET) {
        return null;
    }

    const parsed = parseOidcIssuer(OIDC_ISSUER);

    if (parsed.issuer === null) {
        if (loggedIssuerError !== parsed.error) {
            loggedIssuerError = parsed.error;
            authLogger.error(`[auth] ${parsed.error} — OIDC sign-in is disabled`);
        }

        return null;
    }

    return oidcDiscoveryUrl(parsed.issuer);
};

const isOidcConfigured = (): boolean => resolveOidcDiscoveryUrl() !== null;

/**
 * A plugin whose `init` may not take longer than `ms`.
 *
 * `genericOAuth` fetches the issuer's discovery document inside `init`, with no
 * timeout — and `init` gates every auth request of the isolate. An issuer that
 * hangs would hang sign-in for everyone, email included. Past the deadline the
 * provider is skipped for this isolate (its button then errors) and auth
 * carries on; `genericOAuth` already treats a failed discovery the same way.
 */
const withInitDeadline = <P extends BetterAuthPlugin>(plugin: P, ms: number): P => {
    const { init } = plugin;

    if (!init) {
        return plugin;
    }

    return {
        ...plugin,
        init: async (ctx) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const deadline = new Promise<undefined>((resolve) => {
                timer = setTimeout(() => {
                    authLogger.error(`[auth] ${plugin.id} init exceeded ${ms}ms — OIDC sign-in is unavailable in this isolate`);
                    resolve(undefined);
                }, ms);
            });

            try {
                return await Promise.race([init(ctx), deadline]);
            } finally {
                clearTimeout(timer);
            }
        },
    };
};

/** What `GET /api/auth/sign-in-methods` reports — derived from the same env the providers are. */
export const resolveSignInMethods = (): SignInMethods => {
    return {
        oidc: isOidcConfigured() ? { label: OIDC_BUTTON_LABEL || "Single sign-on", providerId: OIDC_PROVIDER_ID } : null,
        passkey: true,
        social: Object.keys(buildSocialProviders()),
    };
};

/** The WebAuthn relying party is the APP origin — the browser runs the ceremony there, behind the `/api/auth` proxy. */
const passkeyRelyingParty = (): { origin: string | null; rpID: string } => {
    try {
        const site = new URL(SITE_URL);

        return { origin: site.origin, rpID: site.hostname };
    } catch {
        return { origin: null, rpID: "localhost" };
    }
};

// =============================================================================
// Better Auth Options Factory
// =============================================================================

/**
 * Build the better-auth options. Called once per isolate by `buildAuth` below.
 *
 * Exported for `auth.plugins.test.ts`: which plugins are installed is a security
 * property (invite-only registration lives in this list), and nothing else can
 * observe it without a live worker — `buildAuth` needs real D1 and shard bindings.
 */
/** Callbacks `buildAuthOptions` wires into plugins; `buildAuth` supplies them from the Worker env. */
interface AuthOptionHooks {
    /** An anonymous user converted to a real account (a NEW user). See `lib/account-merge.ts`. */
    onGuestConverted?: (guestId: string, userId: string) => Promise<void>;
}

/**
 * Per-path overrides for better-auth's `/api/auth/*` rate limiter.
 *
 * The limiter is ON (`@lunora/auth` enables it with `storage: "database"`, a D1
 * row per client IP + path) at better-auth's defaults: 100 requests per 10 s
 * window for any path, 3 per 10 s for `/sign-in*`, `/sign-up*`,
 * `/change-password`, `/change-email`, 3 per 60 s for password-reset and
 * verification mail, and the plugins' own rules (magic link 5 / 60 s, two-factor
 * 3 / 10 s, email OTP send 3 / 60 s). Anonymous sign-in is `/sign-in/anonymous`,
 * so it stays at 3 / 10 s.
 *
 * The window is not a fixed 10 s bucket: every allowed request moves the row's
 * `lastRequest`, and the count only resets after a 10 s QUIET gap. So "100 per
 * 10 s" is really "100 in a row without a 10 s pause" — then 429 until one.
 * `get-session` is the one read every tab issues on its own (Lunora's identity
 * probe and better-auth's session atom, per tab and page load), so a
 * handful of people behind one office NAT or VPN keep that bucket from ever
 * pausing, reach 100, and get 429 on the read that decides whether they are
 * signed in at all. The web app now treats that as "unknown", not "signed
 * out" (`apps/web/src/lib/auth/session-read.ts`), but the read should not
 * fail in the first place.
 *
 * `get-session` is exempt (`false` = no limit):
 * - it cannot be used to guess anything — a session cookie is an HMAC-signed
 *   random token, verified before any lookup, and a bad one costs no DB read;
 * - a valid one is answered from the 60 s signed cookie cache
 *   (`@lunora/auth` default) without touching D1, so an authenticated caller
 *   spamming it costs no more than any RPC, which is not per-request limited
 *   either;
 * - the limiter itself is the expensive part: one D1 read + write per request.
 *
 * Everything a brute-force or mail-bomb would use keeps its strict rule; this
 * map names only the one path it relaxes. `auth.rate-limit.test.ts` drives
 * better-auth's real limiter to pin both halves.
 */
export const AUTH_RATE_LIMIT_CUSTOM_RULES: Record<string, false | { max: number; window: number }> = {
    "/get-session": false,
};

export const buildAuthOptions = (hooks: AuthOptionHooks = {}): BetterAuthOptions => {
    const oidcDiscovery = resolveOidcDiscoveryUrl();

    return {
        account: {
            accountLinking: {
                enabled: true,
                trustedProviders: ["google"],
                updateUserInfoOnLink: true,
            },
        },
        advanced: {
            cookiePrefix: "neore",
        },
        baseURL: SITE_URL,
        // Database adapter is set by the defineAuth runtime
        emailAndPassword: {
            enabled: true,
            requireEmailVerification: false,
            sendResetPassword: async ({ url, user }) => {
                await sendResetPassword({
                    to: user.email,
                    url,
                });
            },
        },
        emailVerification: {
            sendVerificationEmail: async ({ url, user }) => {
                await sendEmailVerification({
                    to: user.email,
                    url,
                });
            },
        },
        plugins: [
            /**
             * Both halves, or neither.
             *
             * Turning this on from the secret alone is what made every credential
             * endpoint answer `MISSING_RESPONSE` on any machine that had the
             * secret and no `VITE_TURNSTILE_SITE_KEY`: the plugin demanded a token
             * and the form, built without a site key, rendered no widget able to
             * produce one. Sign-up, sign-in and forgot-password all dead, with a
             * submit button that looked like it simply did nothing.
             *
             * Requiring the site key too means a half-configured environment
             * degrades to "no captcha" — which is a real loss of bot protection,
             * so it is announced rather than silent, and `alchemy.run.ts` refuses
             * to deploy in that state at all. Locking everyone out is the worse
             * failure, and it is the one that actually happened.
             */
            ...(TURNSTILE_SECRET_KEY && TURNSTILE_SITE_KEY
                ? [
                      captcha({
                          provider: "cloudflare-turnstile",
                          secretKey: TURNSTILE_SECRET_KEY,
                      }),
                  ]
                : []),
            /**
             * Keys for the public v1 API (`public-api/`). Three settings matter:
             *
             * - `rateLimit` OFF: the plugin's default is 10 requests per DAY, and
             *   its counter is a read-modify-write on a D1 row. Per-key limits are
             *   enforced by the router through `rateLimits` instead, which is
             *   atomic under the DO input gate like every other limit here.
             * - `defaultPermissions` read-only: a key created without scopes (the
             *   plain better-auth client call) can never write.
             * - `nk_` prefix: identifiable in logs and by secret scanners.
             *
             * Scoped keys are minted server-side by `auth_api_keys.createScopedApiKey`,
             * because `permissions` is a server-only field of `/api-key/create`.
             */
            apiKey({
                defaultPrefix: API_KEY_PREFIX,
                permissions: { defaultPermissions: DEFAULT_API_SCOPES },
                rateLimit: { enabled: false },
            }),
            anonymous({
                // Converting creates a NEW user, and the guest's rows live on the
                // guest's shard: move them to the new user's (`lib/account-merge.ts`).
                ...(hooks.onGuestConverted && {
                    onLinkAccount: async ({ anonymousUser, newUser }) => {
                        await hooks.onGuestConverted?.(String(anonymousUser.user.id), String(newUser.user.id));
                    },
                }),
            }),
            /**
             * Invite-only registration. Gates email sign-up (including an anonymous
             * user converting to a real account, which creates a new user) and
             * social first-sign-in. Anonymous sign-in stays open: `inviteOnly()`
             * exempts rows carrying `isAnonymous` as of `@lunora/auth@127`, so
             * the wrapper this used to need is gone.
             *
             * `allowFirstUser` is deliberately left off: it races two concurrent
             * sign-ups and opens a window between deploy and the owner signing up.
             * Seed the first invitation with `createSignUpInvitation` instead —
             * `auth/invitations.ts` exposes that to admins.
             */
            ...(SIGNUP_INVITE_ONLY ? [inviteOnly()] : []),
            // `GET /sign-in-methods`, the verified-email rule for OAuth first
            // sign-in under the invite gate, and no passkeys for guests.
            signInMethods(resolveSignInMethods(), { inviteOnly: SIGNUP_INVITE_ONLY }),
            /**
             * Passkeys. Registration needs a signed-in, non-guest session
             * (`requireSession` + the guest refusal in `signInMethods`), so a
             * passkey never creates a user and the invite gate is untouched;
             * sign-in with one only reaches an account that already exists.
             */
            passkey({
                ...passkeyRelyingParty(),
                registration: { requireSession: true },
                rpName: "Neore",
            }),
            /**
             * Enterprise SSO against one OIDC issuer. Discovered from the
             * issuer, so the id token is verified against its JWKS with a
             * nonce; PKCE on. `requireIdTokenVerification` skips the provider
             * when discovery names no `issuer` + `jwks_uri` — without it
             * better-auth falls back to DECODING the id token unverified, and
             * its `email_verified` is what the invite gate trusts. A first
             * sign-in creates a user and so meets the invite gate like any
             * social provider.
             */
            ...(oidcDiscovery
                ? [
                      withInitDeadline(
                          genericOAuth({
                              config: [
                                  {
                                      clientId: OIDC_CLIENT_ID,
                                      clientSecret: OIDC_CLIENT_SECRET,
                                      discoveryUrl: oidcDiscovery,
                                      name: OIDC_BUTTON_LABEL || "Single sign-on",
                                      pkce: true,
                                      providerId: OIDC_PROVIDER_ID,
                                      requireIdTokenVerification: true,
                                      scopes: ["openid", "email", "profile"],
                                  },
                              ],
                          }),
                          OIDC_DISCOVERY_DEADLINE_MS,
                      ),
                  ]
                : []),
            organization({
                ac,
                allowUserToCreateOrganization: true,
                creatorRole: "owner",
                invitationExpiresIn: INVITATION_EXPIRATION_SECONDS,
                membershipLimit: MEMBERSHIP_LIMIT,
                organizationLimit: ORGANIZATION_LIMIT,
                roles,
                schema: {
                    organization: {
                        additionalFields: {
                            monthlyCredits: {
                                defaultValue: 0,
                                input: false,
                                required: false,
                                type: "number",
                            },
                            ownerId: {
                                required: false,
                                type: "string",
                            },
                        },
                    },
                },
                sendInvitationEmail: async (data) => {
                    await sendOrganizationInvite({
                        acceptUrl: `${SITE_URL}/w/${data.organization.slug}?invite=${data.id}`,
                        invitationId: data.id,
                        inviterEmail: data.inviter.user.email,
                        inviterName: data.inviter.user.name || "Team Admin",
                        organizationName: data.organization.name,
                        role: data.role,
                        to: data.email,
                    });
                },
                teams: {
                    enabled: true,
                    maximumTeams: 10,
                },
            }),
            admin({
                ac,
                defaultRole: "user",
                roles: { admin: roles.admin, user: roles.member },
            }),
            magicLink({
                sendMagicLink: async ({ email, url }) => {
                    await sendMagicLink({
                        to: email,
                        url,
                    });
                },
            }),
            emailOTP({
                async sendVerificationOTP({ email, otp }) {
                    await sendOTPVerification({
                        code: otp,
                        to: email,
                    });
                },
            }),
            twoFactor(),
            // Lunora resolves identity in the worker, so only the JWT/JWKS half is
            // needed — better-auth ships that as `jwt()`.
            jwt({
                jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } },
                // `sid` (OIDC's session-id claim) on top of the default user
                // payload, so `resolveIdentity` can hand the RPC its session id.
                // Without it `getSession(ctx)` was null on every bearer call, and
                // everything that checks the session row — account deletion's
                // freshness guard first — refused every user.
                jwt: {
                    definePayload: ({ session, user }) => {
                        return { ...user, sid: session.id };
                    },
                },
            }),
            // The native shell's system-browser sign-in: one-time code + PKCE
            // verifier → session cookie on the app origin. Accepts only codes
            // issued for `neore://auth/callback`; see `auth/client-grant-cookie.ts`.
            clientGrantCookie(),
        ],
        // Only the overrides: `@lunora/auth` fills `enabled: true`, `storage: "database"`
        // and its own catch-all rule, which it merges AFTER these so ours match first.
        rateLimit: { customRules: AUTH_RATE_LIMIT_CUSTOM_RULES },
        // Every social provider is optional — email+password always works.
        socialProviders: buildSocialProviders(),
        telemetry: { enabled: false },
        // better-auth takes `string[]` OR `(request) => string[]` — never an array
        // containing a function, which is what the `as unknown as string[]` cast
        // was hiding. `matchesOriginPattern` calls `pattern.includes("*")` on each
        // entry, so a function entry throws `pattern.includes is not a function`.
        //
        // It never surfaced because `.some()` short-circuits on the baseURL origin
        // and the check is skipped entirely for requests without a cookie (so
        // sign-up never reaches it). It fires once a caller has BOTH a session and
        // a non-baseURL origin — i.e. the deployed split-Worker topology, on
        // sign-out, change-password, 2FA and org mutations, as a 500 rather than a
        // clean 403. The extension allowance never worked either.
        trustedOrigins: (request?: { headers: Headers }): string[] => {
            const origin = request?.headers.get("origin");

            // Reflecting any `chrome-extension://` origin trusts EVERY extension
            // the user has installed, which is not a set we control — one of them
            // could drive authenticated auth mutations against this backend. Only
            // the ids we ship are allowed, and an unset var allows none.
            return origin && trustedExtensionOrigins.includes(origin) ? [origin] : [];
        },
        user: {
            changeEmail: {
                enabled: false,
            },
            // OFF on purpose. better-auth's `/delete-user` removes the `user`,
            // `session` and `account` rows and nothing else — every thread,
            // file, memory and key would outlive the account with no owner to
            // erase them for. Account deletion is `gdpr.requestAccountDeletion`,
            // which runs the full workflow; the settings "Delete Account"
            // dialog (`delete-account-dialog.tsx`) calls that instead.
            deleteUser: {
                enabled: false,
            },
        },
    };
};

// =============================================================================
// Auth instance
// =============================================================================

/** The subset of the Worker env `buildAuth` needs. */
interface AuthEnv {
    /** Either spelling is accepted; `resolveAuthSecret` requires exactly one to be set. */
    AUTH_SECRET?: string;
    BETTER_AUTH_SECRET?: string;
    DB: Parameters<typeof lunoraD1Adapter>[0];
    ENVIRONMENT?: string;
    SHARD: Parameters<typeof createShardClient>[0];
    /** DEV-ONLY routing switch, see `lib/shard-namespace.ts`. */
    SHARD_ROUTING?: string;
}

/**
 * better-auth's own default signing key. Published in its source, so a token
 * signed with it can be forged by anyone.
 */
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";

/**
 * The session/JWT signing secret, or a hard failure.
 *
 * better-auth resolves `options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET || ""`
 * and then silently substitutes the constant above, logging a warning nobody
 * reads. A Worker deployed without the binding therefore comes up looking
 * healthy while signing every session cookie and every JWT with a key that is in
 * the package on npm — anyone can mint a session for any user id.
 *
 * Refusing to boot is the only safe reading of a missing secret. Two names are
 * accepted because both are in use here: `AUTH_SECRET` as the Worker binding and
 * `BETTER_AUTH_SECRET` in `lib/env-validation.ts`.
 */
const resolveAuthSecret = (env: AuthEnv): string => {
    // AUTH_SECRET FIRST, and the order is load-bearing: this code has always
    // passed `secret: env.AUTH_SECRET` explicitly, which overrides better-auth's
    // own `BETTER_AUTH_SECRET || AUTH_SECRET` resolution. Preferring the other
    // name changes the effective secret wherever both are set, and the JWKS
    // private key is encrypted with it — the symptom is
    // "Failed to decrypt private key" on `/api/auth/token`, i.e. every login
    // works and every RPC token 500s.
    const secret = env.AUTH_SECRET?.trim() || env.BETTER_AUTH_SECRET?.trim();

    if (!secret) {
        throw new Error("AUTH_SECRET (or BETTER_AUTH_SECRET) is not set — refusing to start rather than sign sessions with better-auth's public default key.");
    }

    if (secret === BETTER_AUTH_DEFAULT_SECRET) {
        throw new Error("AUTH_SECRET is better-auth's published default key — sessions signed with it are forgeable by anyone.");
    }

    return secret;
};

/**
 * Build the better-auth instance for this isolate.
 *
 * The lifecycle hooks below are the triggers translated to better-auth's
 * `databaseHooks`. One behavioural difference is worth stating plainly: a trigger
 * that runs inside the auth write's transaction rolls the auth write back when it
 * fails. A `databaseHook` cannot — the auth row is already committed
 * when `after` runs. Every hook body in `auth/hooks.ts` is therefore idempotent
 * and safe to re-run, and none of them is load-bearing for the auth write itself.
 */
let cached: null | ReturnType<typeof createAuth> = null;

// Annotated, because the inferred type names better-auth's `Auth` and thirteen
// copies of better-auth are resolved in this workspace — TypeScript cannot pick
// a stable path to any of them (`TS2883: cannot be named without a reference to
// 'Auth' from '.pnpm/better-auth@1.6.23_…'`). `createAuth`'s own return is the
// type we mean, and it is nameable from here.
export const buildAuth = (env: AuthEnv): ReturnType<typeof createAuth> => {
    if (cached) {
        return cached;
    }

    /**
     * System-privileged caller. Each hook runs on the user's OWN shard, where
     * every request of theirs lands (`src/shard-routing.ts`) and so where their
     * `userSettings` / `aiUserPreferences` rows must be seeded.
     */
    const shard = createShardClient(routedShardNamespace(env.SHARD, env));

    cached = createAuth({
        ...buildAuthOptions({
            // Queued, not run here: moving a guest's rows takes a round trip per
            // table and page, too long to hold the sign-up request. The job runs
            // on the NEW user's shard (`lib/account-merge.ts#runGuestMerge`).
            onGuestConverted: async (guestId, userId) => {
                try {
                    await enqueueJob(internal.lib.account_merge.runGuestMerge, { from: guestId, to: userId }, { shardKey: userId });
                } catch (error) {
                    // The account itself is created; losing the guest's history
                    // must not fail the sign-up.
                    authLogger.error(`[auth] queueing the move of guest ${guestId} to ${userId} failed:`, error);
                }
            },
        }),
        database: lunoraD1Adapter(env.DB),
        databaseHooks: {
            user: {
                create: {
                    after: async (user) => {
                        const userId = String(user.id);

                        await shard.call(internal.auth.hooks.initializeUserDefaults, { userId: userId as Id<"user"> }, { shardKey: userId });
                    },

                    /**
                     * Assign the admin role at signup.
                     *
                     * Gated on BOTH the `ADMIN` allowlist AND `emailVerified`.
                     * Without the second condition an attacker who learns an
                     * admin's address could pre-claim the role through the
                     * email/password path (`requireEmailVerification` is false).
                     * OAuth signups arrive verified, so real admin onboarding is
                     * unaffected; anyone else is promoted later by
                     * `promoteVerifiedAdmin`.
                     *
                     * The `callerRole` reset is defence in depth: it strips a
                     * caller-supplied `role: "admin"` when the email is not
                     * allowlisted, in case a future better-auth upgrade stops
                     * honouring the field's `input: false`.
                     */
                    before: async (user) => {
                        const email = String(user.email ?? "").toLowerCase();
                        const isAdmin = adminEmails().includes(email);
                        const callerRole = user.role === "admin" ? "user" : ((user.role as string | undefined) ?? "user");

                        return { data: { ...user, role: isAdmin && user.emailVerified ? "admin" : callerRole } };
                    },
                },
                update: {
                    after: async (user) => {
                        const userId = String(user.id);

                        await shard.call(internal.auth.hooks.promoteVerifiedAdmin, { userId: userId as Id<"user"> }, { shardKey: userId });
                    },
                },
            },
        },
        // Membership and organizations change through better-auth (the web app
        // calls these routes directly, and neore's own procedures call
        // `auth.api.*`), and a Team subscription follows both: its seats track
        // the members, and a deleted organization's plan is cancelled. The org
        // plugin has no hook for `leave` and writes through the raw adapter, so
        // this is the one place that sees every route — and, running after the
        // route, only a change that actually happened.
        hooks: {
            after: createAuthMiddleware(async (context) => {
                const { returned } = context.context;
                const deletedOrganizationId = deletedOrganizationOf(context.path, returned);
                const organizationId = organizationOfMemberChange(context.path, returned);

                if (deletedOrganizationId) {
                    await queueOrganizationBillingCancel(deletedOrganizationId);
                } else if (organizationId) {
                    await queueSeatSync(organizationId);
                }
            }),
        },
        secret: resolveAuthSecret(env),
    });

    return cached;
};

/**
 * The better-auth instance, from inside a procedure.
 *
 * Lunora procedures have no `env`, and `createAuth` is an isolate-level
 * singleton anyway, so this returns the instance `buildAuth` cached on the first request.
 *
 * Throws rather than lazily building: a procedure reaching this before the worker
 * has handled a request means the app was composed without `.auth(...)`, and a
 * silent second instance would use a different secret.
 */
export const getAuth = (): ReturnType<typeof createAuth> => {
    if (!cached) {
        throw new Error("Auth is not initialised — the worker builds it on the first request");
    }

    return cached;
};

/**
 * Cascade-delete a user's app-owned rows.
 *
 * better-auth has no `user.delete` databaseHook, so this cannot be wired the way
 * the create/update hooks are — it is called explicitly from the account-deletion
 * flow (`gdpr/`).
 */
export const deleteUserCascade = async (env: AuthEnv, userId: string): Promise<void> => {
    await createShardClient(routedShardNamespace(env.SHARD, env), { shardKey: userId }).call(internal.auth.hooks.cascadeDeleteUser, {
        userId: userId as Id<"user">,
    });
};

export default buildAuth;

// =============================================================================
// Re-exports
// =============================================================================

/**
 * `auth.ts` is the single import site for these (~70 call sites do
 * `import { getAuthUserIdentity } from "../auth"`), so the re-export stays even
 * though the implementations live in `auth/session.ts`.
 */
export type { AuthUserIdentity, SessionClientSignals } from "./auth/session";
export { getAuthUserId, getAuthUserIdentity, getHeaders, getSession, getSessionNetworkSignals } from "./auth/session";
