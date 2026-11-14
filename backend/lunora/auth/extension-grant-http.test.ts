/**
 * `POST /extension/auth/authorize`, the one route that starts an app's sign-in (the Firefox extension, the desktop
 * app and the phone app). The session it reads decides: an admin impersonating the user gets no code, so no grant.
 */
import type { HttpActionCtx } from "lunorash/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MOBILE_REDIRECT_URI, NATIVE_REDIRECT_URI, SHIPPED_FIREFOX_REDIRECT_URI } from "../lib/extension-origins";
import type { ExtensionGrantStore } from "./extension-grant";
import { pkceChallenge } from "./extension-grant";
import { authorizeExtensionHttpAction } from "./extension-grant-http";

const state = vi.hoisted(() => {
    return { codes: [] as string[], sessions: 0 };
});

vi.mock("../env", async () => {
    const origins = await import("../lib/extension-origins");

    return {
        PUBLIC_ORIGIN: "https://api.example.test",
        TRUSTED_EXTENSION_REDIRECT_URIS: [origins.SHIPPED_FIREFOX_REDIRECT_URI, origins.NATIVE_REDIRECT_URI, origins.MOBILE_REDIRECT_URI].join(","),
    };
});

vi.mock("../auth", () => {
    return {
        getAuth: () => {
            return {};
        },
    };
});

vi.mock("./extension-grant", async (importOriginal) => {
    const original = await importOriginal<typeof import("./extension-grant")>();
    const store = {
        createSession: async () => {
            state.sessions += 1;

            return { expiresAt: new Date(Date.now() + 60_000), token: "session" };
        },
        findUser: async (id: string) => {
            return { email: "ada@example.test", id, isAnonymous: false, name: "Ada" };
        },
        saveCode: async (identifier: string) => {
            state.codes.push(identifier);
        },
    } as unknown as ExtensionGrantStore;

    return { ...original, createExtensionGrantStore: () => store };
});

const USER = "user-1";
const CHALLENGE = await pkceChallenge("v".repeat(50));
/** The extension's, the desktop app's and the phone app's. */
const REDIRECT_URIS = [SHIPPED_FIREFOX_REDIRECT_URI, NATIVE_REDIRECT_URI, MOBILE_REDIRECT_URI] as const;

/** The caller's verified bearer identity, and what its session row reads (`getSessionOrganizationForCap`). */
const contextFor = (
    identity: { grantSessionId?: string; sessionId?: string; userId: string },
    session: null | { impersonating?: boolean; organizationId: null | string },
) => {
    const runQuery = vi.fn(async () => session);

    return { context: { auth: { getIdentity: async () => identity, userId: identity.userId }, runQuery } as unknown as HttpActionCtx, runQuery };
};

const authorize = async (context: HttpActionCtx, redirectUri: string = REDIRECT_URIS[0]): Promise<Response> =>
    await authorizeExtensionHttpAction(
        context,
        new Request("https://api.example.test/extension/auth/authorize", {
            body: JSON.stringify({ codeChallenge: CHALLENGE, redirectUri }),
            headers: { "content-type": "application/json" },
            method: "POST",
        }),
    );

beforeEach(() => {
    state.codes = [];
    state.sessions = 0;
});

describe("POST /extension/auth/authorize", () => {
    it("issues a code for the user's own web session", async () => {
        const { context, runQuery } = contextFor({ sessionId: "sid-1", userId: USER }, { organizationId: null });
        const response = await authorize(context);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ code: expect.any(String) });
        expect(runQuery).toHaveBeenCalledWith(expect.anything(), { sessionId: "sid-1", userId: USER });
        expect(state.codes).toHaveLength(1);
    });

    it.each(REDIRECT_URIS)("refuses an admin impersonating the user, for %s: no code, no session", async (redirectUri) => {
        const { context } = contextFor({ sessionId: "sid-1", userId: USER }, { impersonating: true, organizationId: null });
        const response = await authorize(context, redirectUri);

        expect(response.status).toBe(403);
        expect(await response.json()).toStrictEqual({
            error: "access_denied",
            message: "Apps can't be signed in while impersonating. Sign in as yourself to connect one.",
        });
        expect(state.codes).toHaveLength(0);
        expect(state.sessions).toBe(0);
    });

    it("refuses an app's own grant, which carries no impersonation mark, without reading a session", async () => {
        const { context, runQuery } = contextFor({ grantSessionId: "gsid-1", userId: USER }, { organizationId: null });
        const response = await authorize(context);

        expect(response.status).toBe(401);
        expect(runQuery).not.toHaveBeenCalled();
        expect(state.codes).toHaveLength(0);
    });

    it("refuses a web session that is gone, expired or another user's", async () => {
        const { context } = contextFor({ sessionId: "sid-gone", userId: USER }, null);
        const response = await authorize(context);

        expect(response.status).toBe(401);
        expect(state.codes).toHaveLength(0);
    });
});
