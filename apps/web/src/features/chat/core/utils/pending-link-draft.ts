/**
 * A prompt link opened without a signed-in account is applied as a draft, and the composer lives in memory. A sign-in that leaves the page
 * (a full navigation, or a provider's redirect) would lose that draft, which was never sent. So the draft is also kept in session storage,
 * with the account it was opened under, and the first chat page that sees a different account takes it, once.
 */

const KEY = "neore.pendingLinkDraft";

/** A draft that waited longer than this is not carried into a sign-in any more. */
const MAX_AGE_MS = 30 * 60 * 1000;

export interface PendingLinkDraft {
    model?: string;
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
        (candidate.model === undefined || typeof candidate.model === "string") &&
        typeof candidate.savedAt === "number" &&
        (candidate.userId === null || typeof candidate.userId === "string")
    );
};

/** Keeps `draft` for the sign-in return, under the account it was opened by (`null` when signed out). Nothing is kept if storage is unavailable. */
export const savePendingLinkDraft = (draft: PendingLinkDraft, userId: string | null, now: number = Date.now()): void => {
    try {
        const stored: StoredPendingLinkDraft = { ...draft, savedAt: now, userId };

        sessionStorage.setItem(KEY, JSON.stringify(stored));
    } catch {
        // Storage is unavailable (or full): the draft is applied on this page only.
    }
};

/**
 * The kept draft, if a different account is signed in now than when it was kept. Taking it removes it, so it is applied once. The same
 * account opening a chat again is not a sign-in return, and leaves the draft for one.
 */
export const takePendingLinkDraft = (userId: string | null, now: number = Date.now()): PendingLinkDraft | undefined => {
    try {
        const raw = sessionStorage.getItem(KEY);

        if (raw === null) {
            return undefined;
        }

        const parsed: unknown = JSON.parse(raw);

        if (!isStoredPendingLinkDraft(parsed) || now - parsed.savedAt > MAX_AGE_MS) {
            sessionStorage.removeItem(KEY);

            return undefined;
        }

        if (parsed.userId === userId) {
            return undefined;
        }

        sessionStorage.removeItem(KEY);

        return parsed.model === undefined ? { prompt: parsed.prompt } : { model: parsed.model, prompt: parsed.prompt };
    } catch {
        // A value that cannot be read is dropped, so it is never taken later; storage that cannot be read is simply nothing.
        try {
            sessionStorage.removeItem(KEY);
        } catch {
            // Nothing more to do.
        }

        return undefined;
    }
};
