/**
 * API-key identity for `/api/v1/*`.
 *
 * `server.ts`'s `resolveIdentity` hands requests on this path to
 * `resolveApiKeyIdentity` INSTEAD of the JWT/cookie resolver — never in
 * addition to it. Two consequences, both deliberate:
 *
 * - An API key authenticates nothing outside `/api/v1`. It cannot drive
 *   `/_lunora/rpc`, where no scope check runs.
 * - A browser session does not authenticate `/api/v1`. The global CORS policy
 *   answers credentialed requests from the app's origin, so accepting the cookie
 *   here would make every v1 write reachable from the app page without a key
 *   and without scopes.
 *
 * The resolved identity carries `userId`, which is what makes the handlers'
 * `ctx.runQuery(api.…)` calls run AS the key's owner through the unmodified
 * public procedures — their auth checks, ban enforcement and rate limits
 * included. Scopes ride along as claims and are checked by the router.
 */
import type { ApiScopes } from "./scopes";
import { parseScopes } from "./scopes";

export const PUBLIC_API_PREFIX = "/api/v1";

/** Keys minted by this app start with this. Older/foreign keys still verify; the prefix only helps humans and secret scanners. */
export const API_KEY_PREFIX = "nk_";

export const isPublicApiPath = (pathname: string): boolean => pathname === PUBLIC_API_PREFIX || pathname.startsWith(`${PUBLIC_API_PREFIX}/`);

const BEARER_PATTERN = /^Bearer\s+(\S+)$/iu;

/** `Authorization: Bearer <key>` first, then `X-API-Key`. Empty values count as absent. */
export const extractApiKey = (headers: Headers): string | null => {
    const authorization = headers.get("Authorization")?.trim();

    if (authorization) {
        const match = BEARER_PATTERN.exec(authorization);

        if (match?.[1]) {
            return match[1];
        }
    }

    const header = headers.get("X-API-Key")?.trim();

    return header || null;
};

/** The subset of better-auth's `verifyApiKey` answer this reads. */
export interface ApiKeyVerification {
    key: {
        enabled?: boolean | null;
        id: string;
        permissions?: unknown;
        referenceId: string;
    } | null;
    valid: boolean;
}

export type ApiKeyVerifier = (key: string) => Promise<ApiKeyVerification>;

/**
 * The two `@better-auth/api-key` server endpoints this app calls.
 *
 * `auth.api` is typed from `buildAuthOptions()`'s declared `BetterAuthOptions`,
 * which erases the plugin list — so plugin endpoints are absent from the type
 * though present at runtime. This names the part we use instead of casting to `any`.
 */
export interface ApiKeyAuthApi {
    createApiKey: (options: {
        body: { expiresIn?: number; name?: string; permissions?: Record<string, string[]>; userId: string };
    }) => Promise<{ expiresAt?: Date | number | string | null; id: string; key: string; name?: string | null; start?: string | null }>;
    verifyApiKey: (options: { body: { key: string } }) => Promise<ApiKeyVerification>;
}

export interface ApiKeyIdentity {
    [claim: string]: unknown;
    apiKeyId: string;
    apiKeyScopes: ApiScopes;
    authMethod: "api_key";
    userId: string;
}

/** Longest a key may be before it is not worth a database lookup. better-auth's default is 64 + prefix. */
const MAX_KEY_LENGTH = 256;

export const resolveApiKeyIdentity = async (request: Request, verify: ApiKeyVerifier): Promise<ApiKeyIdentity | null> => {
    const key = extractApiKey(request.headers);

    if (!key || key.length > MAX_KEY_LENGTH) {
        return null;
    }

    let result: ApiKeyVerification;

    try {
        result = await verify(key);
    } catch {
        // A verifier failure (D1 blip) must fail CLOSED — anonymous, which every
        // authenticated route answers with 401 — rather than propagate and 500
        // the request with an internal message.
        return null;
    }

    if (!result.valid || !result.key || result.key.enabled === false || !result.key.referenceId) {
        return null;
    }

    return {
        apiKeyId: result.key.id,
        apiKeyScopes: parseScopes(result.key.permissions),
        authMethod: "api_key",
        userId: result.key.referenceId,
    };
};

/**
 * Read the identity back inside a handler.
 *
 * The runtime splits a resolved identity: `userId` becomes `ctx.auth.userId`
 * and only the REST comes back from `ctx.auth.getIdentity()` — so the user id
 * is passed separately. Anything not minted by `resolveApiKeyIdentity` (a
 * session, a JWT) is rejected.
 */
export const readApiKeyIdentity = (claims: unknown, userId: unknown): ApiKeyIdentity | null => {
    if (!claims || typeof claims !== "object" || typeof userId !== "string" || userId.length === 0) {
        return null;
    }

    const candidate = claims as Partial<ApiKeyIdentity>;

    if (candidate.authMethod !== "api_key" || typeof candidate.apiKeyId !== "string") {
        return null;
    }

    return {
        apiKeyId: candidate.apiKeyId,
        apiKeyScopes: parseScopes(candidate.apiKeyScopes),
        authMethod: "api_key",
        userId,
    };
};
