/**
 * Reads the sign-up invitation token out of the URL.
 *
 * Registration is invite-only (`SIGNUP_INVITE_ONLY` on the backend), and
 * `@lunora/auth`'s gate reads an `inviteToken` off the sign-up request body. The
 * token reaches the browser exactly one way — the `?invite=` parameter on the
 * link an administrator sends — so it is read from the URL at submit time rather
 * than threaded through the auth-card prop chain, which the anonymous-conversion
 * dialog is not part of.
 *
 * Anonymous sign-in needs none of this; only creating a real account does.
 */

/** The query parameter an invitation link carries. */
export const INVITE_TOKEN_PARAM = "invite";

/**
 * Pulls the token out of a query string.
 *
 * Returns `undefined` for a missing or blank token so callers can pass the value
 * straight through — an absent key and an empty string are the same rejection
 * (`SIGN_UP_INVITE_INVALID`) to the server, and `undefined` drops out of the JSON
 * body rather than sending a field the user never supplied.
 */
export const parseInviteToken = (search: string): string | undefined => {
    let parameters: URLSearchParams;

    try {
        parameters = new URLSearchParams(search);
    } catch {
        return undefined;
    }

    return parameters.get(INVITE_TOKEN_PARAM)?.trim() || undefined;
};

/** Runs {@link parseInviteToken} against the live URL; `undefined` during SSR. */
export const readInviteToken = (): string | undefined => (globalThis.window === undefined ? undefined : parseInviteToken(globalThis.window.location.search));

/**
 * Adds `inviteToken` to a sign-up payload when the visitor arrived on an
 * invitation link.
 *
 * The cast is the point of this helper, and it is confined to it. `inviteToken`
 * is consumed by the server's invite gate before better-auth validates the body
 * and is never stored on the user, so better-auth's generated sign-up type has no
 * slot for it — and `@lunora/auth` ships no client plugin that would add one.
 * Returning `T` keeps every call site fully typed on the fields that DO belong to
 * sign-up.
 */
export const withInviteToken = <T extends object>(payload: T, inviteToken: string | undefined = readInviteToken()): T =>
    (inviteToken === undefined ? payload : { ...payload, inviteToken }) as T;
