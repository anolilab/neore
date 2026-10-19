/**
 * A notification that points at a locked chat must not carry its title or body.
 * Rows written before the lock still hold the title, so the inbox redacts at read
 * time too. The thread is found by the `/chat/<threadId>` link every chat-linked
 * writer uses.
 */
import type { Id } from "../_generated/dataModel";
import { isThreadLocked, LOCKED_THREAD_TITLE } from "../lib/thread-lock";

const CHAT_LINK = /^\/chat\/([^/?#]+)/;

/** True when `link` names a thread that is currently locked. Unreadable threads are not locked here. */
export const linksToLockedThread = async (
    db: { get: (id: Id<"threads">) => Promise<{ lockedAt?: number | null } | null> },
    link: string | undefined,
): Promise<boolean> => {
    const threadId = link?.match(CHAT_LINK)?.[1];

    if (threadId === undefined) {
        return false;
    }

    const thread = await db.get(threadId as Id<"threads">);

    return thread !== null && isThreadLocked(thread);
};

/** The notification's fields with the subject and the body replaced. */
export const redactForLockedThread = <T extends { body?: string; title: string }>(notification: T): T => {
    return { ...notification, body: undefined, title: LOCKED_THREAD_TITLE };
};
