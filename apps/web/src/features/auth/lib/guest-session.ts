/**
 * @file Single-flight guest sign-in, and the recovery that gets its session
 * onto the RPC client.
 *
 * `<AutoGuestSignIn>` fired `signIn.anonymous` TWICE in dev: StrictMode mounts,
 * unmounts and remounts it, and both effect runs passed the "no session yet"
 * check before either sign-in answered — the `hasAttempted` state it guarded
 * with was captured as `false` in both closures. Two guests were minted and the
 * second overwrote the first's cookie. The same race exists in production
 * whenever the `<Unauthenticated>` gate remounts it (the RPC token lands a
 * moment after the cookie) or two routes mount it at once.
 *
 * So the attempt lives here, at module scope: every caller that arrives while
 * one is running joins it. Once it settles the slot clears, and a later caller
 * starts over — which is safe, because the existing-session check below turns a
 * late call into a no-op.
 *
 * A LATE caller is not hypothetical. Lunora's identity probe
 * (`LunoraClient.getCurrentUser`) reads ANY non-2xx answer as "nobody", so one
 * failed probe after a successful guest sign-in flips the gate back to
 * `<Unauthenticated>` and remounts the component with the guest's cookie
 * already set. Two things then went wrong (seen in an e2e run: a 200 sign-in,
 * then a 400 one ~300ms later, and `/chat` blank for good):
 *
 * - a failed `getSession()` read as "no session" and minted a second guest,
 *   which better-auth refuses with `ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY`;
 * - nothing asked Lunora to probe again, so the gate stayed shut over a valid
 *   session. `adoptSessionToken` is that ask.
 *
 * ✅ Safe to import in client components
 */
import { waitForCredentialRequests } from "@/lib/auth/sign-in-lock";

export interface GuestSessionClient {
    getSession: () => Promise<{ data?: { user?: unknown } | null; error?: unknown }>;
    signIn: { anonymous: (options: { fetchOptions: { throw: true } }) => Promise<unknown> };
}

/** `existing`: someone was already signed in, so nothing was minted. `created`: a guest was. */
export type GuestSessionOutcome = "created" | "existing";

/** better-auth's answer to an anonymous sign-in from a browser that already holds a guest session. */
export const ALREADY_ANONYMOUS_CODE = "ANONYMOUS_USERS_CANNOT_SIGN_IN_AGAIN_ANONYMOUSLY";

/** `getSession()` failed, so whether anyone is signed in is unknown — retry, never mint. */
export class GuestSessionUnknownError extends Error {
    public override readonly cause: unknown;

    public constructor(cause: unknown) {
        super("Could not read the current session");
        this.name = "GuestSessionUnknownError";
        this.cause = cause;
    }
}

/**
 * True for better-auth's "you are already a guest" refusal. With
 * `fetchOptions.throw`, better-fetch throws a `BetterFetchError` whose `error`
 * is the response body (`{ code, message }`).
 */
export const isAlreadyAnonymousError = (error: unknown): boolean => {
    const body = (error as { error?: { code?: unknown } } | null | undefined)?.error;

    return body?.code === ALREADY_ANONYMOUS_CODE;
};

/** Held on an object so the slot can be cleared from inside the attempt. */
const attempt: { inFlight?: Promise<GuestSessionOutcome> } = {};

const run = async (client: GuestSessionClient): Promise<GuestSessionOutcome> => {
    // Let any sign-in that is already ON THE WIRE finish first.
    //
    // A submitted-but-unanswered sign-in has no session cookie yet, so the
    // `getSession()` check below reads it as "nobody is here" and we would mint
    // a guest on top of the account the user is authenticating with. Bounded,
    // so a hung request cannot leave `/chat` sessionless forever.
    await waitForCredentialRequests();

    // Confirm there is genuinely no session before minting a guest.
    //
    // The `<Unauthenticated>` gate reflects the RPC client's token, which is
    // fetched a moment AFTER the session cookie lands. Someone who has just
    // signed in with a password therefore looks logged-out for that window —
    // and without this check we would sign them in as a guest on top of the real
    // session they just created.
    const { data: existingSession, error: sessionError } = await client.getSession();

    if (existingSession?.user) {
        return "existing";
    }

    // A FAILED read is not "nobody": better-auth answers `{ data: null, error }`
    // for a 5xx or a 429 as well. Minting on it signs a guest in over whatever
    // session the request could not see — a real account included, which the
    // anonymous plugin does not refuse.
    if (sessionError) {
        throw new GuestSessionUnknownError(sessionError);
    }

    try {
        await client.signIn.anonymous({ fetchOptions: { throw: true } });
    } catch (error) {
        // The server saw a guest session this tab could not: that IS the
        // session we wanted, not a failure.
        if (isAlreadyAnonymousError(error)) {
            return "existing";
        }

        throw error;
    }

    return "created";
};

/** Sign in as a guest unless somebody is already signed in; concurrent callers share one attempt. */
export const ensureGuestSession = async (client: GuestSessionClient): Promise<GuestSessionOutcome> => {
    attempt.inFlight ??= run(client).finally(() => {
        attempt.inFlight = undefined;
    });

    return await attempt.inFlight;
};

export interface IdentityTokenClient {
    getAuthToken: () => string | null;
    setAuthToken: (token: string | null) => void;
}

/**
 * Hand the RPC client this browser's session token so Lunora probes the
 * identity again.
 *
 * Only for a caller that KNOWS a session exists while the client still reads
 * unauthenticated. Lunora re-probes only when the token CHANGES, and the server
 * caches tokens per session cookie, so the fetched token is often the one the
 * client already holds (the one whose probe failed). Clearing it first forces
 * the change; the client is unauthenticated at that point, so nothing is lost.
 */
export const adoptSessionToken = async (client: IdentityTokenClient, fetchToken: () => Promise<string | null | undefined>): Promise<void> => {
    const token = await fetchToken();

    if (!token) {
        throw new Error("No RPC token for the current session");
    }

    if (client.getAuthToken() === token) {
        client.setAuthToken(null);
    }

    client.setAuthToken(token);
};

/** First adoption waits this long: the normal path (`AuthRecovery`) usually gets there first. */
const ADOPTION_BASE_DELAY_MS = 1000;

/** Ceiling for the adoption backoff. */
const ADOPTION_MAX_DELAY_MS = 30_000;

/** A quiet spell this long resets the backoff. */
const ADOPTION_RESET_MS = 60_000;

const adoption = { count: 0, lastAt: -Infinity };

/**
 * Delay before the next session-token adoption from `<AutoGuestSignIn>`.
 *
 * Module-level, because the loop it bounds runs ACROSS mounts: adopt → probe
 * fails → `<Unauthenticated>` remounts the component → adopt again. A
 * per-component counter would restart at zero on every lap and poll a failing
 * backend as fast as it answers.
 */
export const nextAdoptionDelay = (now: number = Date.now()): number => {
    if (now - adoption.lastAt > ADOPTION_RESET_MS) {
        adoption.count = 0;
    }

    const delay = Math.min(ADOPTION_BASE_DELAY_MS * 2 ** adoption.count, ADOPTION_MAX_DELAY_MS);

    adoption.count += 1;
    adoption.lastAt = now + delay;

    return delay;
};

/** Test-only: forget the adoption backoff. */
export const resetAdoptionBackoff = (): void => {
    adoption.count = 0;
    adoption.lastAt = -Infinity;
};
