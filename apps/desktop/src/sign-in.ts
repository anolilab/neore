/**
 * Sign-in through the SYSTEM browser, for providers that refuse embedded
 * webviews (Google answers `disallowed_useragent`).
 *
 * 1. The shell makes a verifier, a challenge and a `state`, and opens the site's
 * `auth/extension` page (with `client=native`) in the default browser.
 * 2. The user signs in there and the page redirects to the `neore://auth/callback`
 * URL, carrying `code` and `state` in its query.
 * 3. The OS hands that URL back to this app. The `state` must match the ONE
 * flow this process started, or the callback is dropped.
 * 4. The page gets `{ code, codeVerifier, redirectUri }` (`takePendingSignIn`),
 * and posts it to `/api/auth/client-grant/cookie`, which sets the session
 * cookie on the app origin.
 *
 * A custom scheme is not exclusive, so PKCE is what protects the code: a
 * stolen code is useless without the verifier, which never leaves this process.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** The one URL shape the shell accepts: base64url, the same alphabet the backend uses for codes. */
const TOKEN_PATTERN = /^[\w-]+$/u;

const base64Url = (buffer: Buffer): string => buffer.toString("base64url");

/** Base64url of the shape the backend and `beginSignIn` produce; anything else is refused. */
const isToken = (value: string): boolean => value.length >= 16 && value.length <= 128 && TOKEN_PATTERN.test(value);

export const REDIRECT_URI = "neore://auth/callback";

/** The backend's code lives one minute; this covers the user signing in first. */
export const SIGN_IN_TTL_MS = 15 * 60 * 1000;

export interface PendingSignIn {
    startedAt: number;
    state: string;
    verifier: string;
}

/** What the page needs to finish the exchange; field names match the backend body. */
export interface SignInHandoff {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}

/** RFC 7636 S256: BASE64URL(SHA-256(ASCII(code_verifier))). */
export const pkceChallenge = (verifier: string): string => base64Url(createHash("sha256").update(verifier, "utf8").digest());

/** Starts a flow, replacing any earlier one: only the latest browser tab can finish. */
export const beginSignIn = (origin: URL, now: number = Date.now()): { pending: PendingSignIn; url: URL } => {
    // 32 random bytes → 43 base64url characters, the RFC 7636 minimum verifier length.
    const pending: PendingSignIn = {
        startedAt: now,
        state: base64Url(randomBytes(16)),
        verifier: base64Url(randomBytes(32)),
    };

    const url = new URL("auth/extension", origin);

    url.searchParams.set("client", "native");
    url.searchParams.set("code_challenge", pkceChallenge(pending.verifier));
    url.searchParams.set("redirect_uri", REDIRECT_URI);
    url.searchParams.set("state", pending.state);

    return { pending, url };
};

/**
 * The `code` and `state` of a `neore://auth/callback` URL, or `undefined` for
 * anything else. The shape is checked before anything else reads the values.
 */
export const parseSignInCallback = (link: URL): { code: string; state: string } | undefined => {
    if (link.protocol !== "neore:" || link.hostname !== "auth" || link.pathname !== "/callback") {
        return undefined;
    }

    const code = link.searchParams.get("code") ?? undefined;
    const state = link.searchParams.get("state") ?? undefined;

    if (code === undefined || state === undefined || !isToken(code) || !isToken(state)) {
        return undefined;
    }

    return { code, state };
};

/**
 * Matches a callback against the pending flow. Consumes the flow either way,
 * so a wrong or replayed `state` cannot be retried against it. Throws with the
 * reason; the caller logs it without the code.
 */
/** Whether a callback's `state` is the one the flow in progress issued. Constant-time, like the check in `completeSignIn`. */
export const isFlowState = (pending: PendingSignIn, state: string): boolean => {
    const expected = Buffer.from(pending.state);
    const received = Buffer.from(state);

    return expected.length === received.length && timingSafeEqual(expected, received);
};

export const completeSignIn = (pending: PendingSignIn | undefined, code: string, state: string, now: number = Date.now()): SignInHandoff => {
    if (pending === undefined) {
        throw new Error("no sign-in in progress");
    }

    if (now - pending.startedAt > SIGN_IN_TTL_MS) {
        throw new Error("the sign-in took too long; start it again");
    }

    const expected = Buffer.from(pending.state);
    const received = Buffer.from(state);

    if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
        throw new Error("the sign-in callback does not belong to this app's request");
    }

    return { code, codeVerifier: pending.verifier, redirectUri: REDIRECT_URI };
};

/** Hosts whose sign-in page refuses embedded webviews. Navigation there is cancelled and the flow above starts instead. */
export const isBlockedOauthUrl = (raw: string): boolean => {
    const parsed = URL.parse(raw);

    return parsed?.protocol === "https:" && parsed.hostname === "accounts.google.com";
};
