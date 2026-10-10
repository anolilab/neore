/**
 * @file Tracks credential requests that are in flight on the shared auth client.
 *
 * A sign-in that has been SUBMITTED but not yet answered has no session cookie
 * yet, so `authClient.getSession()` reports "no session" — the guard in
 * `auto-guest-signin.tsx` cannot see it, and mints a guest on top of the account
 * the user is in the middle of authenticating with, silently downgrading it.
 *
 * The auth client's own fetch CAN see it, and it is the one place every
 * credential flow passes through (password, social, passkey, OTP, magic link,
 * two-factor, anonymous). Marking the request there and waiting on it in the
 * auto guest path closes the window without every form having to remember to.
 *
 * ✅ Safe to import in client components
 */

/** Paths under `/api/auth` whose completion changes who the caller is. */
const CREDENTIAL_PATH = /\/(?:sign-in|sign-up|callback|magic-link|one-tap|passkey|two-factor|verify-email|reset-password)(?:\/|$)/;

/**
 * Never block guest sign-in for longer than this. A hung credential request must
 * not leave `/chat` permanently unusable — a late guest beats no session at all.
 */
const WAIT_TIMEOUT_MS = 10_000;

const inFlight = new Set<Promise<unknown>>();

export const isCredentialRequest = (url: string): boolean => CREDENTIAL_PATH.test(url.split("?", 1)[0] ?? url);

/**
 * Runs `request` while `signInInFlight()` reports true. Releases on rejection
 * too — a network error must not wedge the flag on forever.
 */
export const trackCredentialRequest = async <T>(request: Promise<T>): Promise<T> => {
    // Waiters only care THAT it settled, so they wait on a copy that cannot reject.
    const settled = request.then(() => undefined).catch(() => undefined);

    inFlight.add(settled);

    try {
        return await request;
    } finally {
        inFlight.delete(settled);
    }
};

export const signInInFlight = (): boolean => inFlight.size > 0;

/** Resolves once every credential request in flight has settled (or timed out). */
export const waitForCredentialRequests = async (): Promise<void> => {
    if (inFlight.size === 0) {
        return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
        await Promise.race([
            Promise.all(inFlight),
            new Promise<void>((resolve) => {
                timer = setTimeout(resolve, WAIT_TIMEOUT_MS);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
};
