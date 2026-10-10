/**
 * HTTP surface of the extension sign-in flow — see `extension-grant.ts` for the
 * protocol and why it exists.
 *
 * - `POST /extension/auth/authorize` — the web app, as the signed-in user (the
 *   RPC bearer JWT), asks for a code. Identity comes from `resolveIdentity`.
 * - `POST /extension/auth/exchange` — the extension trades code + verifier for
 *   its session token. Unauthenticated by design: the code IS the credential.
 * - `POST /extension/auth/token` — session token → short-lived JWT.
 * - `POST /extension/auth/revoke` — sign out.
 *
 * The session token travels in the JSON body, never in `Authorization`, so
 * `resolveIdentity` does not try to verify it as a JWT, and never in a URL.
 */
import type { HttpActionCtx } from "lunorash/server";
import { v } from "lunorash/server";

import { getAuth } from "../auth";
import { PUBLIC_ORIGIN, TRUSTED_EXTENSION_REDIRECT_URIS } from "../env";
import { parseTrustedExtensionRedirectUris } from "../lib/extension-origins";
import { authLogger } from "../lib/logger";
import {
    authorizeExtension,
    createExtensionGrantStore,
    exchangeExtensionCode,
    ExtensionGrantError,
    mintExtensionAccessToken,
    revokeExtensionSession,
} from "./extension-grant";

const trustedRedirectUris = parseTrustedExtensionRedirectUris(TRUSTED_EXTENSION_REDIRECT_URIS);

/** Tokens and codes must never be cached by anything between here and the extension. */
const NO_STORE = { "Cache-Control": "no-store" };

const errorResponse = (error: unknown): Response => {
    if (error instanceof ExtensionGrantError) {
        return Response.json({ error: error.code, message: error.message }, { headers: NO_STORE, status: error.status });
    }

    authLogger.error("[extension-auth] unexpected failure", error);

    return Response.json({ error: "server_error" }, { headers: NO_STORE, status: 500 });
};

/** The JSON body, validated; a malformed one is `invalid_request`, not a 500. */
const readBody = async <T>(request: Request, parse: (value: unknown) => T): Promise<T> => {
    try {
        return parse(await request.json());
    } catch {
        throw new ExtensionGrantError("invalid_request", "Malformed request body.");
    }
};

const authorizeBody = v.object({ codeChallenge: v.string(), redirectUri: v.string() });
const exchangeBody = v.object({ code: v.string(), codeVerifier: v.string(), redirectUri: v.string() });
const tokenBody = v.object({ token: v.string() });

export const authorizeExtensionHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    try {
        const body = await readBody(request, (value) => authorizeBody.parse(value));
        const result = await authorizeExtension(createExtensionGrantStore(getAuth()), {
            ...body,
            trustedRedirectUris,
            userId: context.auth.userId as null | string | undefined,
        });

        return Response.json(result, { headers: NO_STORE });
    } catch (error) {
        return errorResponse(error);
    }
};

export const exchangeExtensionCodeHttpAction = async (_context: HttpActionCtx, request: Request): Promise<Response> => {
    try {
        const body = await readBody(request, (value) => exchangeBody.parse(value));
        const result = await exchangeExtensionCode(createExtensionGrantStore(getAuth()), {
            ...body,
            ipAddress: request.headers.get("cf-connecting-ip") ?? undefined,
            userAgent: request.headers.get("user-agent") ?? undefined,
        });

        return Response.json(result, { headers: NO_STORE });
    } catch (error) {
        return errorResponse(error);
    }
};

export const extensionAccessTokenHttpAction = async (_context: HttpActionCtx, request: Request): Promise<Response> => {
    try {
        const { token } = await readBody(request, (value) => tokenBody.parse(value));
        // The same origin `server.ts` pins `iss`/`aud` to when verifying.
        const origin = PUBLIC_ORIGIN || new URL(request.url).origin;
        const result = await mintExtensionAccessToken(createExtensionGrantStore(getAuth()), { origin, token });

        return Response.json(result, { headers: NO_STORE });
    } catch (error) {
        return errorResponse(error);
    }
};

export const revokeExtensionSessionHttpAction = async (_context: HttpActionCtx, request: Request): Promise<Response> => {
    try {
        const { token } = await readBody(request, (value) => tokenBody.parse(value));

        await revokeExtensionSession(createExtensionGrantStore(getAuth()), token);

        return new Response(null, { headers: NO_STORE, status: 204 });
    } catch (error) {
        return errorResponse(error);
    }
};
