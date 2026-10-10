/**
 * Drives the REAL better-auth endpoint (memory adapter) end to end: a code the
 * grant issued for the native redirect URI, plus its verifier, becomes a signed
 * session cookie that better-auth itself then accepts.
 */
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { describe, expect, it } from "vitest";

import { NATIVE_REDIRECT_URI, SHIPPED_FIREFOX_REDIRECT_URI } from "../lib/extension-origins";
import { clientGrantCookie } from "./client-grant-cookie";
import { authorizeExtension, createExtensionGrantStore, pkceChallenge } from "./extension-grant";

const BASE_URL = "http://localhost:3000";
const VERIFIER = "n".repeat(50);

const setup = async () => {
    const db: Record<string, Record<string, unknown>[]> = { account: [], session: [], user: [], verification: [] };
    const auth = betterAuth({
        baseURL: BASE_URL,
        database: memoryAdapter(db),
        emailAndPassword: { enabled: true },
        plugins: [clientGrantCookie()],
        secret: "a-test-secret-that-is-long-enough-for-better-auth",
    });
    const { user } = await auth.api.signUpEmail({ body: { email: "ada@example.test", name: "Ada", password: "correct horse battery" } });
    const store = createExtensionGrantStore(auth);

    const issue = async (redirectUri: string) =>
        await authorizeExtension(store, {
            codeChallenge: await pkceChallenge(VERIFIER),
            redirectUri,
            trustedRedirectUris: [SHIPPED_FIREFOX_REDIRECT_URI, NATIVE_REDIRECT_URI],
            userId: user.id,
        });

    const exchange = async (body: Record<string, string>) =>
        await auth.handler(
            new Request(`${BASE_URL}/api/auth/client-grant/cookie`, {
                body: JSON.stringify(body),
                headers: { "content-type": "application/json", origin: BASE_URL },
                method: "POST",
            }),
        );

    return { auth, exchange, issue, user };
};

describe("POST /api/auth/client-grant/cookie", () => {
    it("turns a native code + verifier into a session cookie better-auth accepts", async () => {
        const { auth, exchange, issue, user } = await setup();
        const { code } = await issue(NATIVE_REDIRECT_URI);

        const response = await exchange({ code, codeVerifier: VERIFIER, redirectUri: NATIVE_REDIRECT_URI });

        expect(response.status).toBe(200);
        const body = await response.json();

        expect(body).toMatchObject({ user: { email: "ada@example.test", id: user.id } });

        const cookie = response.headers.get("set-cookie") ?? "";

        expect(cookie).toContain("better-auth.session_token=");
        expect(cookie.toLowerCase()).toContain("httponly");

        const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie.split(";", 1)[0] as string }) });

        expect(session?.user.id).toBe(user.id);
    });

    it("burns the code: a replay is refused", async () => {
        const { exchange, issue } = await setup();
        const { code } = await issue(NATIVE_REDIRECT_URI);
        const body = { code, codeVerifier: VERIFIER, redirectUri: NATIVE_REDIRECT_URI };

        const first = await exchange(body);

        expect(first.status).toBe(200);

        const replay = await exchange(body);

        expect(replay.status).toBe(400);
        expect(replay.headers.get("set-cookie")).toBeNull();
    });

    it("refuses a wrong verifier without setting a cookie", async () => {
        const { exchange, issue } = await setup();
        const { code } = await issue(NATIVE_REDIRECT_URI);

        const response = await exchange({ code, codeVerifier: "w".repeat(50), redirectUri: NATIVE_REDIRECT_URI });

        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();
    });

    it("never turns an EXTENSION code into a cookie", async () => {
        const { exchange, issue } = await setup();
        const { code } = await issue(SHIPPED_FIREFOX_REDIRECT_URI);

        const response = await exchange({ code, codeVerifier: VERIFIER, redirectUri: SHIPPED_FIREFOX_REDIRECT_URI });

        expect(response.status).toBe(400);
        expect(response.headers.get("set-cookie")).toBeNull();
    });
});
