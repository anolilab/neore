import type { NotTypedMarks } from "../../lib/not-typed-text";
import { MOBILE_REDIRECT_URI, NATIVE_REDIRECT_URI } from "../../lib/extension-origins";

/**
 * Which app a grant's session was made for, recorded on the session row (`session.clientGrant`) by the code exchange
 * (`extension-grant.ts#exchangeExtensionCode`), from the redirect URI the code was issued for. The request never names it.
 */
export type ClientGrantKind = "desktop" | "extension" | "mobile";

/** The kind a code issued for `redirectUri` signs in: the phone app's and the desktop shell's own callbacks, else a browser extension. */
export const clientGrantKindOf = (redirectUri: string): ClientGrantKind => {
    if (redirectUri === MOBILE_REDIRECT_URI) {
        return "mobile";
    }

    return redirectUri === NATIVE_REDIRECT_URI ? "desktop" : "extension";
};

/**
 * The owner's own first-party apps, which they signed in to: what they send counts as typed. A browser extension does
 * not: it relays page and selection text, so its turns and steers are marked (`lib/not-typed-text.ts`, `extension`).
 */
const OWNER_APP_GRANTS: ReadonlySet<unknown> = new Set<ClientGrantKind>(["desktop", "mobile"]);

/**
 * How a sign-in's session row stands for `userId`: `null` when it cannot be read as theirs (none, gone, another user's,
 * expired); `impersonated` for an admin acting as them; `extension` for a browser extension's grant, and for any grant
 * (`viaGrant`, the JWT's `gsid`) or session whose app is not one of the owner's own; else `own`. Fails closed: an
 * unknown or missing grant kind on a grant is `extension`.
 */
export type SignInStanding = "extension" | "impersonated" | "own";

export const signInStanding = (
    session: { clientGrant?: unknown; expiresAt: number; impersonatedBy?: null | string; userId: string } | null | undefined,
    input: { now: number; userId: string; viaGrant: boolean },
): SignInStanding | null => {
    if (!session || session.userId !== input.userId || session.expiresAt <= input.now) {
        return null;
    }

    if (session.impersonatedBy) {
        return "impersonated";
    }

    // A web session names no app; a grant must name one of the owner's own, and a session naming any other app is never own.
    if (session.clientGrant === undefined || session.clientGrant === null ? input.viaGrant : !OWNER_APP_GRANTS.has(session.clientGrant)) {
        return "extension";
    }

    return "own";
};

/**
 * The not-typed marks (`lib/not-typed-text.ts`) what a sign-in of this standing sends is saved with: an admin's
 * `impersonated`, an extension's `extension`, and `impersonated` for one that cannot be confirmed (`null`).
 */
export const notTypedMarksOfStanding = (standing: SignInStanding | null): NotTypedMarks => {
    if (standing === "own") {
        return {};
    }

    return standing === "extension" ? { draft: "extension" } : { impersonated: true };
};
