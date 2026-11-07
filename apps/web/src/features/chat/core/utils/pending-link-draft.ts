/**
 * A prompt link opened without a signed-in account is applied as a draft, and the composer lives in memory. A draft kept this way is put back
 * on the next visit by the same account, so a reload does not lose it. It is kept in session storage with the account it was saved for, and it
 * is never applied to any other account: an entry for a different account is removed, not applied.
 *
 * The entry is removed when it is taken, when it is discarded, when it expires, when it cannot be read, and when the composer is cleared
 * (a sent draft is not restored again: `clearComposer` in `chat-ui-store.ts`).
 */

const KEY = "neore.pendingLinkDraft";

/** A draft that waited longer than this is not carried any further. */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface PendingLinkDraft {
    prompt: string;
}

interface StoredPendingLinkDraft extends PendingLinkDraft {
    savedAt: number;
    userId: string | null;
}

const isStoredPendingLinkDraft = (value: unknown): value is StoredPendingLinkDraft => {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const candidate = value as Record<string, unknown>;

    return (
        typeof candidate.prompt === "string" &&
        candidate.prompt !== "" &&
        typeof candidate.savedAt === "number" &&
        (candidate.userId === null || typeof candidate.userId === "string")
    );
};

const remove = (): void => {
    try {
        sessionStorage.removeItem(KEY);
    } catch {
        // Storage is unavailable: there is nothing kept to remove.
    }
};

/** Keeps `draft` for `userId`, the account it was saved for (`null` when signed out). Nothing is kept if storage is unavailable. */
export const savePendingLinkDraft = (draft: PendingLinkDraft, userId: string | null, now: number = Date.now()): void => {
    try {
        const stored: StoredPendingLinkDraft = { prompt: draft.prompt, savedAt: now, userId };

        sessionStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
        // Storage is unavailable (or full): the draft is applied on this page only.
    }
};

/**
 * Removes the kept draft when it is older than the limit or cannot be read. Run when a chat page mounts, so an entry that nothing reads
 * (a page with its own link, say) does not linger in storage.
 */
export const prunePendingLinkDraft = (now: number = Date.now()): void => {
    try {
        const raw = sessionStorage.getItem(KEY);

        if (raw === null) {
            return;
        }

        const parsed: unknown = JSON.parse(raw);

        if (!isStoredPendingLinkDraft(parsed) || now - parsed.savedAt > MAX_AGE_MS) {
            remove();
        }
    } catch {
        remove();
    }
};

/**
 * The kept draft, for the account it was saved for. An entry is removed whichever account reads it: taken once, and never applied to
 * another account. An expired or unreadable entry is removed and gives nothing.
 */
export const takePendingLinkDraft = (userId: string | null, now: number = Date.now()): PendingLinkDraft | undefined => {
    try {
        const raw = sessionStorage.getItem(KEY);

        if (raw === null) {
            return undefined;
        }

        const parsed: unknown = JSON.parse(raw);

        remove();

        if (!isStoredPendingLinkDraft(parsed) || now - parsed.savedAt > MAX_AGE_MS) {
            return undefined;
        }

        if (parsed.userId !== userId) {
            return undefined;
        }

        return { prompt: parsed.prompt };
    } catch {
        remove();

        return undefined;
    }
};

/** The prompt kept for a visit, read without taking it: the scrubber must know it, because it sits in storage the error report copies. */
export const peekPendingLinkDraftPrompt = (): string | undefined => {
    try {
        const raw = sessionStorage.getItem(KEY);

        if (raw === null) {
            return undefined;
        }

        const parsed: unknown = JSON.parse(raw);

        return isStoredPendingLinkDraft(parsed) ? parsed.prompt : undefined;
    } catch {
        return undefined;
    }
};

/** Removes the kept draft: the composer it came from has been sent or cleared, so it is no longer a draft to restore. */
export const clearPendingLinkDraft = (): void => {
    remove();
};
