/**
 * The passcode proofs of locked chats, held in MEMORY ONLY: never localStorage,
 * never a cookie. A reload therefore re-locks every chat, and so does an idle
 * period. The backend checks each proof on every gated call (`agent/thread-lock.ts`).
 *
 * `withUnlockProof` puts the live proof into a call's args, the one place every
 * procedure call passes through (`crpc.tsx`, `useAction`, `use-uimessages`,
 * `use-delta-streams`), so no call site has to remember it.
 */

import { useSyncExternalStore } from "react";

/** Forget a chat's proof after this long without using it. */
export const UNLOCK_IDLE_MS = 15 * 60 * 1000;

/** The code the backend puts in `error.data.code` when a locked chat is read without a proof. */
export const THREAD_LOCKED_CODE = "THREAD_LOCKED";

interface ProofEntry {
    expiresAt: number;
    lastUsedAt: number;
    proof: string;
}

const proofs = new Map<string, ProofEntry>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const relockListeners = new Set<(threadId: string, proof: string) => void>();
const changeListeners = new Set<() => void>();
const activity = { listening: false };

/** Called whenever a proof is stored or forgotten. Returns the unsubscribe (for `useUnlockProof`). */
export const subscribeUnlockProofs = (listener: () => void): (() => void) => {
    changeListeners.add(listener);

    return () => {
        changeListeners.delete(listener);
    };
};

/**
 * Called with a chat's id and the proof it just lost, each time it is relocked: by
 * expiry or idle timeout, by an explicit forget, or by an account switch. What the
 * chat read with that proof is dropped then (`live-queries.ts`). Returns the unsubscribe.
 */
export const onUnlockExpired = (listener: (threadId: string, proof: string) => void): (() => void) => {
    relockListeners.add(listener);

    return () => {
        relockListeners.delete(listener);
    };
};

const clearTimer = (threadId: string): void => {
    const timer = timers.get(threadId);

    if (timer !== undefined) {
        clearTimeout(timer);
        timers.delete(threadId);
    }
};

/** Forgets a chat's proof and tells the listeners, so they drop what the proof read. */
const relock = (threadId: string): void => {
    const entry = proofs.get(threadId);

    clearTimer(threadId);

    if (entry === undefined) {
        return;
    }

    proofs.delete(threadId);

    for (const listener of changeListeners) {
        listener();
    }

    for (const listener of relockListeners) {
        listener(threadId, entry.proof);
    }
};

/** Re-arms the timer for a proof at the earlier of its expiry and its idle deadline. */
const arm = (threadId: string, entry: ProofEntry, now: number): void => {
    clearTimer(threadId);

    const due = Math.min(entry.expiresAt, entry.lastUsedAt + UNLOCK_IDLE_MS);

    timers.set(
        threadId,
        setTimeout(
            () => {
                relock(threadId);
            },
            Math.max(0, due - now),
        ),
    );
};

/** True once a proof is past its expiry or has sat idle too long. */
const lapsed = (entry: ProofEntry, now: number): boolean => entry.expiresAt <= now || now - entry.lastUsedAt > UNLOCK_IDLE_MS;

/**
 * Any user input counts as use. Reads of the proof do not: a render must not keep a chat open.
 * A proof that already lapsed is relocked, not revived: a throttled timer may not have fired yet.
 */
export const noteUnlockActivity = (now: number = Date.now()): void => {
    for (const [threadId, entry] of proofs) {
        if (lapsed(entry, now)) {
            relock(threadId);
        } else {
            entry.lastUsedAt = now;
            arm(threadId, entry, now);
        }
    }
};

const installActivityListeners = (): void => {
    if (activity.listening || typeof window === "undefined") {
        return;
    }

    activity.listening = true;

    for (const type of ["pointerdown", "keydown"] as const) {
        globalThis.addEventListener(type, () => {
            noteUnlockActivity();
        });
    }
};

/** Keeps the proof an unlock returned, until its expiry or the idle timeout. */
export const rememberUnlockProof = (threadId: string, proof: string, expiresAt: number, now: number = Date.now()): void => {
    const entry: ProofEntry = { expiresAt, lastUsedAt: now, proof };

    proofs.set(threadId, entry);
    arm(threadId, entry, now);
    installActivityListeners();

    for (const listener of changeListeners) {
        listener();
    }
};

/** The live proof for `threadId`, or undefined once it expired or sat idle. */
export const currentUnlockProof = (threadId: string, now: number = Date.now()): string | undefined => {
    const entry = proofs.get(threadId);

    if (!entry) {
        return undefined;
    }

    // This runs during render, so the relock (which tells the listeners) is deferred. The
    // guard keeps a proof re-remembered in the meantime.
    if (lapsed(entry, now)) {
        queueMicrotask(() => {
            if (proofs.get(threadId) === entry) {
                relock(threadId);
            }
        });

        return undefined;
    }

    return entry.proof;
};

/**
 * The live proof for a chat, re-rendering when it changes: a view that was refused
 * (`THREAD_LOCKED`) picks up the proof the moment the unlock lands.
 */
export const useUnlockProof = (threadId: string | undefined): string | undefined =>
    useSyncExternalStore(
        subscribeUnlockProofs,
        () => (threadId === undefined ? undefined : currentUnlockProof(threadId)),
        () => undefined,
    );

/** Re-locks one chat now. */
export const forgetUnlockProof = (threadId: string): void => {
    relock(threadId);
};

/** Re-locks everything (account switch, token subject change). */
export const forgetAllUnlockProofs = (): void => {
    // A Map iterator tolerates the deletes `relock` makes.
    for (const threadId of proofs.keys()) {
        relock(threadId);
    }
};

/**
 * `args` with the live proof for the chat it names, when there is one. Any
 * non-object (`skipToken`, no args) and any call naming no chat pass through
 * unchanged. The backend strips the field from procedures that do not declare it.
 */
export const withUnlockProof = <T>(args: T): T => {
    if (args === null || typeof args !== "object") {
        return args;
    }

    const { chatId, threadId } = args as { chatId?: unknown; threadId?: unknown };
    const named = [threadId, chatId].find((id): id is string => typeof id === "string");

    if (named === undefined) {
        return args;
    }

    const proof = currentUnlockProof(named);

    return proof === undefined ? args : { ...args, unlockProof: proof };
};

/**
 * A plain `fetch` body (`/chat/start`, regenerate, edit, media) for a chat: the
 * same proof, under the `unlockProof` field those routes read.
 */
export const withUnlockProofBody = <T extends object>(body: T, threadId: string | undefined): T => {
    if (threadId === undefined) {
        return body;
    }

    const proof = currentUnlockProof(threadId);

    return proof === undefined ? body : { ...body, unlockProof: proof };
};

/** True for the refusal a locked chat answers with, whichever procedure raised it. */
export const isThreadLockedError = (error: unknown): boolean => (error as { data?: { code?: unknown } } | null)?.data?.code === THREAD_LOCKED_CODE;
