/**
 * Validation of a stored OAuth `state` row when the provider redirects back.
 *
 * The row is bound to the user who STARTED the flow, and completion runs as an
 * authenticated action, so a callback URL replayed into another account's
 * browser is refused rather than attaching the attacker's grant to the victim
 * (or the victim's grant to the attacker).
 */

/** How long a started flow may take. Long enough for a 2FA prompt, short enough to be useless when leaked. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export type OAuthStateCheck = { ok: true } | { ok: false; reason: "expired" | "not_found" | "wrong_user" };

export interface StoredOAuthState {
    expiresAt: number;
    userId: string;
}

/**
 * Decide whether `row` may complete a flow for `userId` at `now`.
 *
 * A missing row covers both "never existed" and "already used" — consumption
 * deletes it, which is what makes the state single-use.
 */
export const checkOAuthState = (row: StoredOAuthState | null, userId: string, now: number): OAuthStateCheck => {
    if (!row) {
        return { ok: false, reason: "not_found" };
    }

    if (row.userId !== userId) {
        return { ok: false, reason: "wrong_user" };
    }

    if (row.expiresAt <= now) {
        return { ok: false, reason: "expired" };
    }

    return { ok: true };
};
