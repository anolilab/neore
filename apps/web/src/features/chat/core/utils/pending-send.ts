/**
 * The message a visitor tried to send before signing in (invite-only: signed
 * out or a guest). Kept in `sessionStorage` so it survives the round trip of an
 * OAuth or magic-link sign-in, which leaves the page and comes back to the same
 * URL; the composer sends it once a real account is signed in
 * (`composer-input.tsx`), then it is gone.
 *
 * It belongs to the chat it was typed in (its path): a composer on any other
 * page leaves it alone, so a visitor who moves to another thread before
 * signing in never has it posted there. It waits for that chat until it
 * expires; closing the sign-in prompt drops it.
 *
 * Text only: attachments belong to an upload session the visitor does not have
 * (signed out) or to a guest account that is not the one signing in.
 *
 * ✅ Safe to import in client components
 */

const PENDING_SEND_KEY = "neore:pending-send";

/** An abandoned sign-in should not send a message hours later. */
export const PENDING_SEND_MAX_AGE_MS = 30 * 60 * 1000;

interface PendingSend {
    /** The pathname of the chat it was typed in. */
    path: string;
    savedAt: number;
    text: string;
}

/** The current page's pathname; `""` outside a browser. */
export const currentPath = (): string => globalThis.location?.pathname ?? "";

const storage = (): Storage | undefined => {
    try {
        return globalThis.sessionStorage;
    } catch {
        // Blocked storage (privacy settings): the message is simply not carried over.
        return undefined;
    }
};

export const savePendingSend = (text: string, path: string = currentPath(), now: number = Date.now()): void => {
    try {
        storage()?.setItem(PENDING_SEND_KEY, JSON.stringify({ path, savedAt: now, text } satisfies PendingSend));
    } catch {
        // Quota or blocked storage: the draft stays in the composer either way.
    }
};

export const clearPendingSend = (): void => {
    try {
        storage()?.removeItem(PENDING_SEND_KEY);
    } catch {
        // Nothing to clear.
    }
};

const parse = (raw: string | null | undefined): PendingSend | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const value = JSON.parse(raw) as Partial<PendingSend> | null;

        return typeof value?.text === "string" && typeof value.savedAt === "number" && typeof value.path === "string"
            ? { path: value.path, savedAt: value.savedAt, text: value.text }
            : undefined;
    } catch {
        return undefined;
    }
};

/**
 * Takes the pending message for the chat at `path`, at most once: the entry is
 * removed before it is returned, so a second caller (StrictMode's second effect
 * run, a second composer) gets nothing. One held for another chat is left in
 * place; a stale, empty or unreadable one is dropped.
 */
export const takePendingSend = (path: string, now: number = Date.now()): string | undefined => {
    let raw: string | null | undefined;

    try {
        raw = storage()?.getItem(PENDING_SEND_KEY);
    } catch {
        return undefined;
    }

    if (raw === null || raw === undefined) {
        return undefined;
    }

    const pending = parse(raw);
    // Saved "in the future" means the clock moved back, so its age is unknown: stale, not fresh.
    const isStale = !pending || pending.text.trim() === "" || pending.savedAt > now || now - pending.savedAt > PENDING_SEND_MAX_AGE_MS;

    if (!isStale && pending.path !== path) {
        return undefined;
    }

    clearPendingSend();

    return isStale ? undefined : pending.text;
};
