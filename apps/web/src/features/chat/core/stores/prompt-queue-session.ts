/**
 * Which session the stored prompt queues belong to: the restore gate, the threads already read back, and the clear on a
 * session end. Apart from `prompt-queue-store` so the root layout can clear queues without putting the store, its queue
 * rules and zustand on the first load; the store registers its in-memory reset when it loads, and before then there is
 * nothing in memory to drop.
 */

export const PROMPT_QUEUE_STORAGE_KEY_PREFIX = "neore:prompt-queue:";

/** Threads already checked against storage this page load, so a drained queue is not resurrected. */
const hydratedThreadIds = new Set<string>();

/**
 * Whether a stored queue may be read back: only once Lunora confirmed the session (`allowPromptQueueRestore`). The chat layout
 * paints before that (`OptimisticAuthGate`), and a queue an ended session left is not the visitor's. Every path in reads it
 * through the store's `hydrate`, and the store keeps a write before then in memory only (`update`).
 */
const restore = { allowed: false };

const memory: { reset?: () => void } = {};

/** The session is confirmed: stored queues may be restored from now on. */
export const allowPromptQueueRestore = (): void => {
    restore.allowed = true;
};

export const isPromptQueueRestoreAllowed = (): boolean => restore.allowed;

/**
 * Whether a thread's stored queue may be read now: once the session is confirmed, and once per thread until the queues are
 * cleared. Marks the thread when it answers true.
 */
export const claimPromptQueueRestore = (threadId: string): boolean => {
    if (!restore.allowed || hydratedThreadIds.has(threadId)) {
        return false;
    }

    hydratedThreadIds.add(threadId);

    return true;
};

/** The store's in-memory reset, called by `clearPromptQueues`. */
export const registerPromptQueueReset = (reset: () => void): void => {
    memory.reset = reset;
};

/**
 * Drops every queue, in memory and in this tab's sessionStorage: the session that queued them has ended. Restoring stays
 * allowed: nothing of the ended session is left to restore, and an account switch keeps the composer mounted, so nothing
 * would allow it again.
 */
export const clearPromptQueues = (): void => {
    hydratedThreadIds.clear();
    memory.reset?.();

    try {
        const storage = globalThis.sessionStorage;

        if (!storage) {
            return;
        }

        const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key) => key?.startsWith(PROMPT_QUEUE_STORAGE_KEY_PREFIX));

        for (const key of keys) {
            storage.removeItem(key as string);
        }
    } catch {
        // Blocked storage: nothing was stored to come back.
    }
};
