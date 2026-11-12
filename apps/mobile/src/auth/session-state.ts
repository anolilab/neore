import type { AuthStatus } from "./auth-state";
import type { GrantUser } from "./grant";

export interface SessionState {
    hasToken: boolean;
    /** Signed in from the stored user, with the first token mint still out. Not offline: the server has not failed yet. */
    isConfirming: boolean;
    /** False once a sign-in has started: the stored user read at launch may be the account that sign-in replaces. */
    isStoredUserCurrent: boolean;
    status: AuthStatus;
    user: GrantUser | null;
}

/**
 * - `stored-user`: the device's own record of who signed in last, read before any request.
 * - `token`: a JWT was minted for the stored grant.
 * - `signed-out`: the server answered "no session" (none stored, expired, revoked, refused), or the person signed out.
 * - `unreachable`: the mint got no answer. The grant is kept and a known user stays signed in.
 * - `sign-in-started`: the browser sign-in opened; a stored read still out may name the account it replaces.
 */
export type SessionEvent = { type: "sign-in-started" | "signed-out" } | { type: "stored-user" | "token" | "unreachable"; user: GrantUser | null };

/**
 * Ends every token mint already out: a sign-in or a sign-out starts a new epoch, and a mint begun in an older one applies
 * nothing (no bearer, no "signed out", no cache wipe) since its grant may be the one being replaced.
 */
export const createAuthEpoch = () => {
    let epoch = 0;

    return {
        end: (): void => {
            epoch += 1;
        },
        /** Starts a mint; the returned check says whether an epoch has ended since. */
        start: (): () => boolean => {
            const startedIn = epoch;

            return () => startedIn !== epoch;
        },
    };
};

// eslint-disable-next-line unicorn/no-null -- `user` is `GrantUser | null` across the auth context
export const INITIAL_SESSION: SessionState = { hasToken: false, isConfirming: false, isStoredUserCurrent: true, status: "loading", user: null };

/**
 * A returning person is signed in from the stored user at once, before the server is asked, so the app opens on their
 * saved chats instead of waiting on the mint. The mint then confirms it (`token`) or ends it (`signed-out`). The stored
 * read only counts while nothing has settled: landing after a mint, a sign-out or the start of a sign-in, it is stale and
 * changes nothing.
 */
export const reduceSession = (state: SessionState, event: SessionEvent): SessionState => {
    switch (event.type) {
        case "sign-in-started": {
            return state.isStoredUserCurrent ? { ...state, isStoredUserCurrent: false } : state;
        }
        case "signed-out": {
            return { ...INITIAL_SESSION, isStoredUserCurrent: false, status: "signed-out" };
        }
        case "stored-user": {
            if (state.status !== "loading" || !state.isStoredUserCurrent || event.user === null) {
                return state;
            }

            return { ...state, hasToken: false, isConfirming: true, status: "signed-in", user: event.user };
        }
        case "token": {
            return { hasToken: true, isConfirming: false, isStoredUserCurrent: false, status: "signed-in", user: event.user };
        }
        case "unreachable": {
            if (event.user === null) {
                return { ...state, isConfirming: false };
            }

            return { ...state, isConfirming: false, status: "signed-in", user: event.user };
        }
        default: {
            return state;
        }
    }
};
