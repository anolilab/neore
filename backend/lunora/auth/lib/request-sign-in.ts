/**
 * The sign-in an HTTP request's identity names, for placing the request in its organization: the web app's session
 * (`sessionId`, from the JWT's `sid`), else the extension's, desktop's or phone's grant (`grantSessionId`, from `gsid`).
 *
 * Only for that lookup. A grant's sign-in is never treated as the caller's session for anything that rests on it, such as
 * account deletion's freshness and impersonation checks (`src/bearer-identity.ts`).
 */
export const requestSignIn = (identity: Record<string, unknown> | null | undefined): string | undefined => {
    if (typeof identity?.sessionId === "string") {
        return identity.sessionId;
    }

    return typeof identity?.grantSessionId === "string" ? identity.grantSessionId : undefined;
};
