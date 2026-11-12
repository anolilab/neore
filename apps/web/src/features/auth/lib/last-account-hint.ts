/**
 * "Someone was signed in here last time": the user id of the last session Lunora confirmed, in `localStorage`.
 *
 * Only a hint for which layout to paint while Lunora's identity probe is in flight
 * (`features/auth/components/optimistic-auth-gate.tsx`). It grants nothing and reads no data: queries still go out with the
 * RPC token, and per-user caches key on the token's subject, never on this id. Written when a session is
 * confirmed, replaced when another account is confirmed, removed on an account switch, when Lunora answers "no session" (sign-out,
 * expiry, revocation) and when sign-out starts. Every storage access is guarded: a blocked store reads as "no hint".
 */

import type { SessionAuthStatus } from "@neore/client-runtime";

const STORAGE_KEY = "neore-last-account";

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

export const writeLastAccountHint = (userId: string): void => {
    try {
        const store = storage();

        if (store && store.getItem(STORAGE_KEY) !== userId) {
            store.setItem(STORAGE_KEY, userId);
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
