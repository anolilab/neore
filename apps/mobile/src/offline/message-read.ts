import type { ScopedCache } from "./cache";
import { MAX_MESSAGES_PER_THREAD } from "./cache";
import { isNetworkFailure } from "./connectivity";
import { settleQuietly } from "./quietly";
import type { MessageRow } from "./types";

/** The code a locked chat's refusal carries in its `data`. */
const THREAD_LOCKED_CODE = "THREAD_LOCKED";

interface ServerVerdict {
    code?: unknown;
    data?: { code?: unknown } | null;
}

/**
 * The server answered that this chat is not for this reader: locked (its content needs a passcode), gone, or no
 * longer shared. A lapsed sign-in is deliberately not one: it says nothing about the chat.
 */
export const isThreadRefusal = (error: unknown): boolean => {
    if (typeof error !== "object" || error === null) {
        return false;
    }

    const { code, data } = error as ServerVerdict;

    return code === "FORBIDDEN" || code === "NOT_FOUND" || data?.code === THREAD_LOCKED_CODE;
};

export interface MessageReadGate {
    /** Starts a read; the returned check is true until a newer read starts or the gate is invalidated. */
    begin: () => () => boolean;
    /** Makes every read begun so far stale, for example when the screen shows another chat. */
    invalidate: () => void;
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
    };
};

export type MessageReadResult
    = { kind: "failed"; message: string }
        | { kind: "refused" }
        | { kind: "rows"; olderCursor: string | null; rows: MessageRow[] }
        | { kind: "superseded" }
        | { kind: "unreachable" };

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
    }
};
