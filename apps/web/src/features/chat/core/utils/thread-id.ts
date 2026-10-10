/**
 * Thread ID validation utilities
 * Centralizes the common pattern of checking if a thread ID is valid (not undefined/null and not "default")
 */

import type { Id } from "@neore/backend/dataModel";

/**
 * Checks if a thread ID is valid (not undefined, null, empty, or "default")
 *
 * Callers hand in raw strings (route params, props, store state); everything that
 * survives this check is a real `threads` document id, so the predicate narrows to
 * the branded `Id&lt;"threads">` the backend api expects.
 */
export const isValidThreadId = (threadId: string | undefined | null): threadId is Id<"threads"> => Boolean(threadId && threadId !== "default");

/**
 * Returns the thread ID if valid, otherwise undefined
 * Useful for passing to hooks/queries that expect undefined to skip.
 */
export const getValidThreadId = (threadId: string | undefined | null): Id<"threads"> | undefined => (isValidThreadId(threadId) ? threadId : undefined);

/**
 * Resolves a thread ID, falling back to a fallback ID, then validates
 * Common pattern: actualThreadId = threadId || currentThreadId, then validate.
 */
export const resolveThreadId = (threadId: string | undefined | null, fallbackThreadId: string | undefined | null): Id<"threads"> | undefined => {
    const resolved = threadId || fallbackThreadId;

    return getValidThreadId(resolved);
};
