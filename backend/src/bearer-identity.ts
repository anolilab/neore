/**
 * The identity a verified bearer JWT stands for, from its claims.
 *
 * `sid` (the web app's JWT, `auth.ts`) becomes `sessionId`, which
 * `getSession(ctx)` reads back (`lunora/auth/session.ts`): account deletion's
 * freshness and impersonation checks rest on it.
 *
 * `gsid` (the extension, desktop and phone JWT, `mintExtensionAccessToken`)
 * becomes `grantSessionId` and NEVER `sessionId`. The grant exchange creates a
 * fresh session with no impersonation mark, so treating it as the caller's
 * session would let any session, of any age, pass those checks. Only
 * session-bound rows that need to know which sign-in made them read it (phone
 * push registration).
 */
export interface BearerIdentity {
    [claim: string]: unknown;
    grantSessionId?: string;
    sessionId?: string;
    userId: string;
}

export const identityFromBearerClaims = (payload: Record<string, unknown>): BearerIdentity | null => {
    if (typeof payload.sub !== "string") {
        return null;
    }

    return {
        userId: payload.sub,
        ...(typeof payload.sid === "string" && { sessionId: payload.sid }),
        ...(typeof payload.gsid === "string" && { grantSessionId: payload.gsid }),
    };
};
