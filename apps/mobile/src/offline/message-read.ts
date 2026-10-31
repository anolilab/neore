import type { ScopedCache } from "./cache";
import { MAX_MESSAGES_PER_THREAD } from "./cache";
import { isNetworkFailure } from "./connectivity";
import { settleQuietly } from "./quietly";
import type { MessageRow } from "./types";

/** The code a locked chat's refusal carries in its `data`. */
const THREAD_LOCKED_CODE = "THREAD_LOCKED";

/**
 * What the thread-messages read says (code `UNAUTHORIZED`) when the chat exists but is no longer shared with the
 * reader. A lapsed sign-in carries the same code with another message, and says nothing about the chat.
 */
const ACCESS_DENIED_MESSAGE = "Access denied to this thread";

interface ServerVerdict {
    code?: unknown;
    data?: { code?: unknown } | null;
    message?: unknown;
}

/**
 * The server answered that this chat is not for this reader: locked (its content needs a passcode), gone, or no
 * longer shared (the grant was revoked). A lapsed sign-in is deliberately not one: it says nothing about the chat.
 */
export const isThreadRefusal = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    const { code, data, message } = error as ServerVerdict;

    return code === "FORBIDDEN" || code === "NOT_FOUND" || data?.code === THREAD_LOCKED_CODE || (code === "UNAUTHORIZED" && message === ACCESS_DENIED_MESSAGE);
};

export interface MessageReadGate {
    /** Starts a read; the returned check is true until a newer read starts or the gate is invalidated. */
    begin: () => () => boolean;
    /** Makes every read begun so far stale, for example when the screen shows another chat. */
    invalidate: () => void;
    /** Like `begin`, without making an earlier read stale: for a page that adds to the current read. */
    watch: () => () => boolean;
}

/** Only the newest read of a screen may paint or save: a slow older one must not put older rows over newer ones. */
export const createMessageReadGate = (): MessageReadGate => {
    let generation = 0;

    return {
        begin: () => {
            generation += 1;

            const mine = generation;

            return () => mine === generation;
        },
        invalidate: () => {
            generation += 1;
        },
        watch: () => {
            const mine = generation;

            return () => mine === generation;
        },
    };
};

export type MessageReadResult
    = { kind: "failed"; message: string }
        | { kind: "refused" }
        | { kind: "rows"; olderCursor: string | null; rows: MessageRow[] }
        | { kind: "superseded" }
        | { kind: "unreachable" };

const failureOf = async (error: unknown, cache: ScopedCache | undefined, threadId: string): Promise<{ kind: "failed"; message: string } | { kind: "refused" } | { kind: "unreachable" }> => {
    if (isNetworkFailure(error)) {
        return { kind: "unreachable" };
    }

    if (isThreadRefusal(error)) {
        // A chat that is locked shows no cached content, and nothing of it stays on the device.
        try {
            await cache?.forgetThreads([threadId]);
        } catch {
            // The refusal stands; a cache that could not forget is retried by the next refused read.
        }

        return { kind: "refused" };
    }

    return { kind: "failed", message: error instanceof Error ? error.message : "Could not load messages." };
};

interface ReadInput {
    cache: ScopedCache | undefined;
    /** Reads the newest pages. `startedAt` stamps the rows: it is when this read began, not when it ended. */
    fetchRows: (startedAt: number) => Promise<{ olderCursor: string | null; rows: MessageRow[] }>;
    gate: MessageReadGate;
    now?: () => number;
    threadId: string;
}

/**
 * One live read of a chat's messages, with the cache work that belongs to its outcome: the rows are saved (stamped
 * with the moment the read began), a refusal of the chat drops the saved copy, and a read that a newer one overtook
 * does neither and says so.
 */
export const readThreadMessages = async ({ cache, fetchRows, gate, now = Date.now, threadId }: ReadInput): Promise<MessageReadResult> => {
    const isCurrent = gate.begin();
    const startedAt = now();

    try {
        const { olderCursor, rows } = await fetchRows(startedAt);

        if (!isCurrent()) {
            return { kind: "superseded" };
        }

        settleQuietly(cache?.saveMessages(threadId, rows.slice(-MAX_MESSAGES_PER_THREAD), { syncedAt: startedAt }));

        return { kind: "rows", olderCursor, rows };
    } catch (error: unknown) {
        if (!isCurrent()) {
            return { kind: "superseded" };
        }

        return failureOf(error, cache, threadId);
    }
};

export type OlderPageResult
    = { kind: "failed"; message: string }
        | { kind: "page"; olderCursor: string | null; rows: MessageRow[] }
        | { kind: "refused" }
        | { kind: "superseded" }
        | { kind: "unreachable" };

interface OlderInput {
    cache: ScopedCache | undefined;
    fetchPage: () => Promise<{ olderCursor: string | null; rows: MessageRow[] }>;
    gate: MessageReadGate;
    threadId: string;
}

/**
 * One older page of a chat. A refusal of the chat is handled exactly as for the newest pages (the saved copy is
 * dropped); a page that the screen moved on from is dropped. The rows are not saved: the cache keeps the newest.
 */
export const readOlderMessages = async ({ cache, fetchPage, gate, threadId }: OlderInput): Promise<OlderPageResult> => {
    const isCurrent = gate.watch();

    try {
        const { olderCursor, rows } = await fetchPage();

        return isCurrent() ? { kind: "page", olderCursor, rows } : { kind: "superseded" };
    } catch (error: unknown) {
        return isCurrent() ? failureOf(error, cache, threadId) : { kind: "superseded" };
    }
};
