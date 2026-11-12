import type { AuthStatus } from "./auth-state";
import type { GrantUser } from "./grant";

export interface SessionState {
    hasToken: boolean;
    /** Signed in from the stored user, with the first token mint still out. Not offline: the server has not failed yet. */
    isConfirming: boolean;
    status: AuthStatus;
    user: GrantUser | null;
}

/**
 * - `stored-user`: the device's own record of who signed in last, read before any request.
 * - `token`: a JWT was minted for the stored grant.
 * - `signed-out`: the server answered "no session" (none stored, expired, revoked, refused), or the person signed out.
 * - `unreachable`: the mint got no answer. The grant is kept and a known user stays signed in.
 */
export type SessionEvent = { type: "signed-out" } | { type: "stored-user" | "token" | "unreachable"; user: GrantUser | null };

// eslint-disable-next-line unicorn/no-null -- `user` is `GrantUser | null` across the auth context
export const INITIAL_SESSION: SessionState = { hasToken: false, isConfirming: false, status: "loading", user: null };

/**
 * A returning person is signed in from the stored user at once, before the server is asked, so the app opens on their
 * saved chats instead of waiting on the mint. The mint then confirms it (`token`) or ends it (`signed-out`). The stored
 * read only counts while nothing has settled: landing after a mint or a sign-out, it is stale and changes nothing.
 */
export const reduceSession = (state: SessionState, event: SessionEvent): SessionState => {
    switch (event.type) {
        case "signed-out": {
            return { ...INITIAL_SESSION, status: "signed-out" };
        }
        case "stored-user": {
            if (state.status !== "loading" || event.user === null) {
                return state;
            }

            return { hasToken: false, isConfirming: true, status: "signed-in", user: event.user };
        }
        case "token": {
            return { hasToken: true, isConfirming: false, status: "signed-in", user: event.user };
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
