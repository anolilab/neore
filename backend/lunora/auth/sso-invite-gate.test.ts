/**
 * Every OAuth first sign-in meets the invite gate — Google, GitHub, Microsoft
 * and the enterprise OIDC provider alike.
 *
 * This drives a REAL better-auth instance built from `buildAuthOptions()`
 * (memory adapter instead of D1) through the real flow: `POST
 * /sign-in/social`, then `GET /callback/:provider` with the state cookie, the
 * provider's token and profile endpoints answered by a stubbed `fetch`. The
 * gate is `inviteOnly()`'s `user.create` hook, which better-auth reaches from
 * the callback — so nothing short of the callback proves a provider is gated.
 * Each refusal has a positive control (same flow, invitation present, user
 * created), so a broken flow cannot pass as a refusal.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SITE = "http://localhost:3000";
const EMAIL = "stranger@example.com";
const MICROSOFT_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

type Provider = "github" | "google" | "microsoft" | "oidc";

/** The configuration of every optional provider, as the deploy would set it. */
const ALL_PROVIDERS_ENV = {
    AUTH_GITHUB_CLIENT_ID: "gh-id",
    AUTH_GITHUB_CLIENT_SECRET: "gh-secret",
    GOOGLE_CLIENT_ID: "google-id",
    GOOGLE_CLIENT_SECRET: "google-secret",
    MICROSOFT_CLIENT_ID: "ms-id",
    MICROSOFT_CLIENT_SECRET: "ms-secret",
    OIDC_BUTTON_LABEL: "Acme SSO",
    OIDC_CLIENT_ID: "oidc-id",
    OIDC_CLIENT_SECRET: "oidc-secret",
    OIDC_ISSUER: "https://idp.example.com/",
    SITE_URL: SITE,
};

const base64url = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

/**
 * A fake of each provider's token/profile/JWKS endpoints. `nonce` is filled in
 * from the authorization URL, because the OIDC provider binds its id token to it.
 */
const stubProviders = async (profile: { emailVerified: boolean }) => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), alg: "RS256", kid: "k1", use: "sig" };
    const state: { nonce?: string } = {};
    const sign = async (claims: Record<string, unknown>, issuer: string, audience: string): Promise<string> =>
        await new SignJWT({ ...claims, ...(state.nonce && { nonce: state.nonce }) })
            .setProtectedHeader({ alg: "RS256", kid: "k1" })
            .setIssuer(issuer)
            .setAudience(audience)
            .setIssuedAt()
            .setExpirationTime("10m")
            .sign(privateKey);
    const claims = { email: EMAIL, email_verified: profile.emailVerified, name: "Stranger" };

    vi.stubGlobal("fetch", async (input: RequestInfo | URL): Promise<Response> => {
        const url = input instanceof Request ? input.url : String(input);

        switch (url) {
            case `https://login.microsoftonline.com/common/oauth2/v2.0/token`: {
                return Response.json({
                    access_token: "at",
                    expires_in: 3600,
                    id_token: await sign(
                        { ...claims, oid: "ms-1", sub: "ms-1", tid: MICROSOFT_TENANT },
                        `https://login.microsoftonline.com/${MICROSOFT_TENANT}/v2.0`,
                        "ms-id",
                    ),
                    token_type: "Bearer",
                });
            }
            case "https://api.github.com/user": {
                return Response.json({ avatar_url: "", email: null, id: 42, login: "stranger", name: "Stranger" });
            }
            case "https://api.github.com/user/emails": {
                return Response.json([{ email: EMAIL, primary: true, verified: profile.emailVerified, visibility: "public" }]);
            }
            case "https://github.com/login/oauth/access_token": {
                return Response.json({ access_token: "at", scope: "read:user,user:email", token_type: "bearer" });
            }
            case "https://idp.example.com/.well-known/openid-configuration": {
                return Response.json({
                    authorization_endpoint: "https://idp.example.com/authorize",
                    id_token_signing_alg_values_supported: ["RS256"],
                    issuer: "https://idp.example.com",
                    jwks_uri: "https://idp.example.com/jwks",
                    token_endpoint: "https://idp.example.com/token",
                    userinfo_endpoint: "https://idp.example.com/userinfo",
                });
            }
            case "https://idp.example.com/jwks": {
                return Response.json({ keys: [jwk] });
            }
            case "https://idp.example.com/token": {
                return Response.json({
                    access_token: "at",
                    expires_in: 3600,
                    id_token: await sign({ ...claims, sub: "oidc-1" }, "https://idp.example.com", "oidc-id"),
                    token_type: "Bearer",
                });
            }
            case "https://oauth2.googleapis.com/token": {
                return Response.json({
                    access_token: "at",
                    expires_in: 3600,
                    // Google's user info is read from the id token, unverified on this path.
                    id_token: `${base64url({ alg: "none" })}.${base64url({ ...claims, aud: "google-id", iss: "https://accounts.google.com", sub: "google-1" })}.x`,
                    token_type: "Bearer",
                });
            }
            default: {
                throw new Error(`unexpected outbound fetch in test: ${url}`);
            }
        }
    });

    return state;
};

/** A better-auth instance from OUR options, on an in-memory store; returns the store for inspection. */
const createTestAuth = async (options: { invited?: boolean } = {}) => {
    const { buildAuthOptions } = await import("../auth");
    const db: Record<string, Record<string, unknown>[]> = {};
    const auth = betterAuth({ ...buildAuthOptions(), baseURL: SITE, database: memoryAdapter(db), secret: "s".repeat(48) });
    const context = await auth.$context;

    for (const table of Object.values(context.tables)) {
        db[table.modelName] ??= [];
    }

    if (options.invited) {
        db.signUpInvitation!.push({ acceptedAt: null, createdAt: new Date(), email: EMAIL, expiresAt: new Date(Date.now() + 3_600_000), id: "inv-1" });
    }

    return { auth, db };
};

/** Start the provider's sign-in and follow its callback; returns where better-auth redirected. */
const signInWith = async (auth: Awaited<ReturnType<typeof createTestAuth>>["auth"], provider: Provider, state: { nonce?: string }): Promise<URL> => {
    const start = await auth.handler(
        new Request(`${SITE}/api/auth/sign-in/social`, {
            body: JSON.stringify({ callbackURL: "/chat", errorCallbackURL: "/auth/sign-in", provider }),
            headers: { "content-type": "application/json", origin: SITE },
            method: "POST",
        }),
    );
    const { url } = (await start.json()) as { url: string };
    const authorization = new URL(url);

    state.nonce = authorization.searchParams.get("nonce") ?? undefined;

    const cookie = start.headers
        .getSetCookie()
        .map((value) => value.split(";", 1)[0])
        .join("; ");
    const callback = await auth.handler(
        new Request(`${SITE}/api/auth/callback/${provider}?code=code&state=${authorization.searchParams.get("state") ?? ""}`, { headers: { cookie } }),
    );

    expect(callback.status).toBe(302);

    return new URL(callback.headers.get("location") ?? "", SITE);
};

const PROVIDERS: Provider[] = ["google", "github", "microsoft", "oidc"];

// Each test imports `../auth` cold after stubbing env — the whole auth graph.
describe("OAuth first sign-in under invite-only", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();

        for (const [key, value] of Object.entries(ALL_PROVIDERS_ENV)) {
            vi.stubEnv(key, value);
        }
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    it.each(PROVIDERS)("refuses %s without an invitation, and creates no user", async (provider) => {
        expect.assertions(4);

        const state = await stubProviders({ emailVerified: true });
        const { auth, db } = await createTestAuth();
        const location = await signInWith(auth, provider, state);

        expect(location.pathname).toBe("/auth/sign-in");
        expect(location.searchParams.get("error")).toBe("SIGN_UP_INVITE_REQUIRED");
        expect(db.user).toStrictEqual([]);
    });

    it.each(PROVIDERS)("admits %s when the address holds an invitation (control)", async (provider) => {
        expect.assertions(4);

        const state = await stubProviders({ emailVerified: true });
        const { auth, db } = await createTestAuth({ invited: true });
        const location = await signInWith(auth, provider, state);

        expect(location.pathname).toBe("/chat");
        expect(db.user?.map((user) => user.email)).toStrictEqual([EMAIL]);
        expect(db.signUpInvitation?.[0]?.acceptedAt).toBeInstanceOf(Date);
    });

    it.each(["github", "oidc"] as const)("refuses %s when the provider does not vouch for the invited address", async (provider) => {
        expect.assertions(3);

        const state = await stubProviders({ emailVerified: false });
        const { auth, db } = await createTestAuth({ invited: true });
        const location = await signInWith(auth, provider, state);

        // GitHub answers with no verified address at all; the OIDC issuer
        // says `email_verified: false`. Either way no invitation is redeemed.
        expect(location.searchParams.get("error")).toBe("OAUTH_EMAIL_UNVERIFIED");
        expect(db.user).toStrictEqual([]);
    });
});

describe("GET /api/auth/sign-in-methods", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    const readMethods = async () => {
        const { auth } = await createTestAuth();
        const response = await auth.handler(new Request(`${SITE}/api/auth/sign-in-methods`));

        return (await response.json()) as unknown;
    };

    it("lists exactly the configured providers", async () => {
        expect.assertions(1);

        for (const [key, value] of Object.entries(ALL_PROVIDERS_ENV)) {
            vi.stubEnv(key, value);
        }

        await stubProviders({ emailVerified: true });

        expect(await readMethods()).toStrictEqual({
            oidc: { label: "Acme SSO", providerId: "oidc" },
            passkey: true,
            social: ["google", "github", "microsoft"],
        });
    });

    it("lists no provider whose id or secret is missing", async () => {
        expect.assertions(1);

        vi.stubEnv("SITE_URL", SITE);
        vi.stubEnv("GOOGLE_CLIENT_ID", "only-an-id");
        vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
        vi.stubEnv("AUTH_GITHUB_CLIENT_ID", "");
        vi.stubEnv("MICROSOFT_CLIENT_ID", "");
        vi.stubEnv("OIDC_ISSUER", "https://idp.example.com");
        vi.stubEnv("OIDC_CLIENT_ID", "");

        expect(await readMethods()).toStrictEqual({ oidc: null, passkey: true, social: [] });
    });
});

describe("OIDC issuer hardening", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();

        for (const [key, value] of Object.entries(ALL_PROVIDERS_ENV)) {
            vi.stubEnv(key, value);
        }
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    const readOidc = async (): Promise<unknown> => {
        const { auth } = await createTestAuth();
        const response = await auth.handler(new Request(`${SITE}/api/auth/sign-in-methods`));

        return ((await response.json()) as { oidc: unknown }).oidc;
    };

    it.each([
        // eslint-disable-next-line unicorn/prefer-https -- a plain-http issuer is the case under test
        ["plain http", "http://idp.example.com/"],
        ["no scheme", "idp.example.com"],
        ["credentials in the URL", "https://user:pass@idp.example.com/"],
    ])("switches OIDC off for an issuer with %s", async (_label, issuer) => {
        expect.assertions(1);

        vi.stubEnv("OIDC_ISSUER", issuer);
        await stubProviders({ emailVerified: true });

        expect(await readOidc()).toBeNull();
    });

    it("keeps email sign-up working when the issuer is malformed", async () => {
        expect.assertions(2);

        vi.stubEnv("OIDC_ISSUER", "::not a url::");
        vi.stubEnv("SIGNUP_INVITE_ONLY", "false");

        const { auth, db } = await createTestAuth();
        const signUp = await auth.handler(
            new Request(`${SITE}/api/auth/sign-up/email`, {
                // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a throwaway test account
                body: JSON.stringify({ email: EMAIL, name: "Member", password: "a-long-enough-password" }), // secret-scanner:allow
                headers: { "content-type": "application/json", origin: SITE },
                method: "POST",
            }),
        );

        expect(signUp.status).toBe(200);
        expect(db.user?.map((user) => user.email)).toStrictEqual([EMAIL]);
    });

    it("skips the provider when discovery names no JWKS, instead of trusting an unverified id token", async () => {
        expect.assertions(3);

        const state = await stubProviders({ emailVerified: true });
        const providers = fetch;

        // Discovery without `jwks_uri`: better-auth would otherwise DECODE the
        // id token unverified; an attacker-signed token must not create a user.
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = input instanceof Request ? input.url : String(input);

            if (url === "https://idp.example.com/.well-known/openid-configuration") {
                return Response.json({
                    authorization_endpoint: "https://idp.example.com/authorize",
                    issuer: "https://idp.example.com",
                    token_endpoint: "https://idp.example.com/token",
                    userinfo_endpoint: "https://idp.example.com/userinfo",
                });
            }

            return await providers(input, init);
        });

        const { auth, db } = await createTestAuth({ invited: true });
        const start = await auth.handler(
            new Request(`${SITE}/api/auth/sign-in/social`, {
                body: JSON.stringify({ callbackURL: "/chat", provider: "oidc" }),
                headers: { "content-type": "application/json", origin: SITE },
                method: "POST",
            }),
        );

        expect(state.nonce).toBeUndefined();
        expect(start.status).toBeGreaterThanOrEqual(400);
        expect(db.user).toStrictEqual([]);
    });
});

describe("verified-email rule under invite-only", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv("SITE_URL", SITE);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("refuses an unverified user created outside the listed paths (fails closed)", async () => {
        expect.assertions(2);

        const { auth, db } = await createTestAuth({ invited: true });
        const context = await auth.$context;

        // A server-side creation outside any request: no endpoint path at all.
        await expect(
            context.internalAdapter.createUser({ email: EMAIL, emailVerified: false, name: "Stranger" }, { method: "email" } as never),
        ).rejects.toMatchObject({
            body: { code: "OAUTH_EMAIL_UNVERIFIED" },
        });
        expect(db.user).toStrictEqual([]);
    });
});

describe("passkeys", { timeout: 30_000 }, () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubEnv("SITE_URL", SITE);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("refuses to register one for a guest session", async () => {
        expect.assertions(2);

        const { auth } = await createTestAuth();
        const guest = await auth.handler(new Request(`${SITE}/api/auth/sign-in/anonymous`, { headers: { origin: SITE }, method: "POST" }));

        expect(guest.status).toBe(200);

        const cookie = guest.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; ");
        const register = await auth.handler(new Request(`${SITE}/api/auth/passkey/generate-register-options`, { headers: { cookie, origin: SITE } }));

        expect(register.status).toBe(403);
    });

    it("offers registration to a signed-in account", async () => {
        expect.assertions(2);

        vi.stubEnv("SIGNUP_INVITE_ONLY", "false");

        const { auth } = await createTestAuth();
        const signUp = await auth.handler(
            new Request(`${SITE}/api/auth/sign-up/email`, {
                // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- a throwaway test account
                body: JSON.stringify({ email: EMAIL, name: "Member", password: "a-long-enough-password" }), // secret-scanner:allow
                headers: { "content-type": "application/json", origin: SITE },
                method: "POST",
            }),
        );
        const cookie = signUp.headers
            .getSetCookie()
            .map((value) => value.split(";", 1)[0])
            .join("; ");
        const register = await auth.handler(new Request(`${SITE}/api/auth/passkey/generate-register-options`, { headers: { cookie, origin: SITE } }));

        expect(register.status).toBe(200);
        expect(((await register.json()) as { rp?: { id?: string } }).rp?.id).toBe("localhost");
    });
});
