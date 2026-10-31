/**
 * The request id of a thread's diff-comment send. `/hosts/send` treats a repeated id as the same message, so an id
 * belongs to one draft as it was sent: reused only when the same comments with the same text are sent again (a retry
 * of a lost answer), and never for comments recreated afterwards, which are a new message even with identical words.
 * Kept across components, so a retry from either place the draft is shown finds the first try.
 */

import type { DiffComment } from "./diff-comments";

const attempts = new Map<string, { comments: string; id: string; text: string }>();

export const requestIdForAttempt = (threadId: string, comments: ReadonlyArray<DiffComment>, text: string): string => {
    const key = comments.map((comment) => comment.id).join("\u{0}");
    const previous = attempts.get(threadId);

    if (previous?.comments === key && previous.text === text) {
        return previous.id;
    }

    const attempt = { comments: key, id: crypto.randomUUID(), text };

    attempts.set(threadId, attempt);

    return attempt.id;
};

/** The draft was accepted: the next send is a new message. */
export const finishSendAttempt = (threadId: string): void => {
    attempts.delete(threadId);
};
