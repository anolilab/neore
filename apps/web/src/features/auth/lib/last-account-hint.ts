/**
 * "Someone was signed in here last time": a fixed marker in `localStorage`, no account id.
 *
 * Only a hint for which layout to paint while Lunora's identity probe is in flight
 * (`features/auth/components/optimistic-auth-gate.tsx`). It grants nothing, reads no data and names nobody: queries
 * still go out with the RPC token, and per-user caches key on the token's subject. Written when a session is
 * confirmed, removed on an account switch, when Lunora answers "no session" (sign-out, expiry, revocation) and when
 * sign-out succeeds. Every storage access is guarded: a blocked store reads as "no hint".
 */

import type { SessionAuthStatus } from "@neore/client-runtime";

const STORAGE_KEY = "neore-signed-in-hint";
/** Presence is all the gate reads; the value is fixed so the browser keeps no identifier. */
const MARKER = "1";

const listeners = new Set<() => void>();

const storage = (): Storage | undefined => {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
};

const notify = (): void => {
    for (const listener of listeners) {
        listener();
    }
};

export const hasLastAccountHint = (): boolean => {
    try {
        return Boolean(storage()?.getItem(STORAGE_KEY));
    } catch {
        return false;
    }
};

export const writeLastAccountHint = (): void => {
    try {
        const store = storage();

        if (store && store.getItem(STORAGE_KEY) !== MARKER) {
            store.setItem(STORAGE_KEY, MARKER);
            notify();
        }
    } catch {
        // A full or blocked store: no hint, so the next start shows the skeleton.
    }
};

export const clearLastAccountHint = (): void => {
    try {
        const store = storage();

        if (store && store.getItem(STORAGE_KEY) !== null) {
            store.removeItem(STORAGE_KEY);
            notify();
        }
    } catch {
        // Nothing stored that could be read either.
    }
};

/**
 * Whether the chat layout paints as signed in before Lunora's identity probe answers: the server read a session, or
 * the last account is remembered and the server has not ANSWERED "no session" (`unknown` is a failed read).
 */
export const startsSignedIn = (serverAuthStatus: SessionAuthStatus | undefined, hasHint: boolean): boolean =>
    serverAuthStatus === "authenticated" || (hasHint && serverAuthStatus !== "unauthenticated");

/** For `useSyncExternalStore`; other tabs' writes arrive through the `storage` event. */
export const subscribeLastAccountHint = (listener: () => void): (() => void) => {
    const onStorage = (event: StorageEvent) => {
        if (event.key === STORAGE_KEY || event.key === null) {
            listener();
        }
    };

    listeners.add(listener);
    globalThis.addEventListener?.("storage", onStorage);

    return () => {
        listeners.delete(listener);
        globalThis.removeEventListener?.("storage", onStorage);
    };
};
