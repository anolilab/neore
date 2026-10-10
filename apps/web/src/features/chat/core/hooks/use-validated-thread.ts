"use client";

import { getValidThreadId, isValidThreadId } from "../utils/thread-id";
import { useThread } from "./use-threads";

/**
 * Hook that resolves and validates a thread ID
 * Returns both the resolved ID and whether it's valid.
 */
export const useResolvedThreadId = (threadId?: string) => {
    const validThreadId = getValidThreadId(threadId);

    return {
        /** The raw thread ID */
        actualThreadId: threadId,
        /** Whether the thread ID is valid */
        isValid: isValidThreadId(threadId),
        /** The validated thread ID (undefined if "default" or falsy) */
        validThreadId,
    };
};

/**
 * Hook that fetches thread data with automatic ID validation.
 *
 * Combines the common pattern of resolving the id (treating `"default"` as absent)
 * and passing only a validated id to `useThread`.
 */
export const useValidatedThread = (threadId?: string) => {
    const { actualThreadId, isValid, validThreadId } = useResolvedThreadId(threadId);
    const threadData = useThread(validThreadId);

    return {
        /** The raw thread ID */
        actualThreadId,
        /** Whether the thread ID is valid */
        isValid,
        /** The thread data from the database */
        threadData,
        /** The validated thread ID (undefined if invalid) */
        validThreadId,
    };
};

// Re-export utilities for convenience
export { getValidThreadId, isValidThreadId, resolveThreadId } from "../utils/thread-id";
