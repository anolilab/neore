/** Where a browser keeps its own token for one guest link, under a digest of the link's token, never the token itself. */
const KEY_PREFIX = "neore.guest-token.";

/** The shape the server takes as a browser's own token (`chat/guest-links.ts`): 64 lowercase hex characters. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/u;

/** Tokens of this page load, for a browser whose storage refuses writes (a private window). */
const memory = new Map<string, string>();

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const keyFor = async (linkToken: string): Promise<string> => {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(linkToken));

    return KEY_PREFIX + hex(new Uint8Array(digest));
};

const read = (key: string): string | null => {
    try {
        return globalThis.localStorage.getItem(key);
    } catch {
        return null;
    }
};

const write = (key: string, value: string | undefined): void => {
    try {
        if (value === undefined) {
            globalThis.localStorage.removeItem(key);
        } else {
            globalThis.localStorage.setItem(key, value);
        }
    } catch {
        // Kept in memory only: a reload then starts a new browser identity, which the bound link refuses.
    }
};

/**
 * This browser's own token for `linkToken`: 32 random bytes, never derived from the link token, made before the first post
 * (`create`) and kept, so a retry after a lost reply carries the token the link was bound to. The server keeps only its
 * hash. Without `create`, `undefined` when this browser has none yet.
 */
export const guestTokenFor = async (linkToken: string, { create = false } = {}): Promise<string | undefined> => {
    const key = await keyFor(linkToken);
    const kept = memory.get(key) ?? read(key);

    if (kept !== null && TOKEN_SHAPE.test(kept)) {
        return kept;
    }

    if (!create) {
        return undefined;
    }

    const token = hex(globalThis.crypto.getRandomValues(new Uint8Array(32)));

    memory.set(key, token);
    write(key, token);

    return token;
};

/**
 * Keeps `token` as this browser's token for `linkToken`: the one a post was just accepted with. Another tab that made its own
 * token at the same moment may have written over it; the accepted one wins.
 */
export const keepGuestToken = async (linkToken: string, token: string): Promise<void> => {
    const key = await keyFor(linkToken);

    memory.set(key, token);
    write(key, token);
};

/** Drops this page's copy of the token, so the next read takes what storage holds (another tab's accepted token). */
export const rereadGuestToken = async (linkToken: string): Promise<void> => {
    memory.delete(await keyFor(linkToken));
};

/** Forgets this browser's token for a link that has ended. */
export const forgetGuestToken = async (linkToken: string): Promise<void> => {
    const key = await keyFor(linkToken);

    memory.delete(key);
    write(key, undefined);
};

/** Where a post not yet confirmed keeps its request id for this tab, under the same digest, so a reload retries it as itself. */
const PENDING_PREFIX = "neore.guest-pending.";

const pendingKeyFor = async (linkToken: string): Promise<string> => {
    const tokenKey = await keyFor(linkToken);

    return PENDING_PREFIX + tokenKey.slice(KEY_PREFIX.length);
};

/**
 * A post sent but not yet confirmed: its request id, its text, and how many of the guest's notes already had that text when
 * it was sent (`seen`), so a note the notes show beyond that count is this post, whatever the clocks say.
 */
export type PendingPost = { requestId: string; seen: number; text: string };

/** A post sent but not yet confirmed (`{ requestId, text }`), kept for this tab across a reload; `undefined` once confirmed. */
export const keepPendingPost = async (linkToken: string, pending: PendingPost | undefined): Promise<void> => {
    const key = await pendingKeyFor(linkToken);

    try {
        if (pending === undefined) {
            globalThis.sessionStorage.removeItem(key);
        } else {
            globalThis.sessionStorage.setItem(key, JSON.stringify(pending));
        }
    } catch {
        // A tab whose storage refuses writes keeps it in memory only.
    }
};

/** The post this tab sent for `linkToken` and has not seen confirmed, if any. */
export const readPendingPost = async (linkToken: string): Promise<PendingPost | undefined> => {
    const key = await pendingKeyFor(linkToken);

    try {
        const parsed: unknown = JSON.parse(globalThis.sessionStorage.getItem(key) ?? "null");
        const { requestId, seen, text } = (parsed ?? {}) as { requestId?: unknown; seen?: unknown; text?: unknown };

        return typeof seen === "number" && typeof requestId === "string" && typeof text === "string" ? { requestId, seen, text } : undefined;
    } catch {
        return undefined;
    }
};

/** Forgets every token of this page load; for tests, which then read only what storage holds. */
export const clearGuestTokenMemory = (): void => {
    memory.clear();
};
