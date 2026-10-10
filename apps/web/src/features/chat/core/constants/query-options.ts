/**
 * Shared query option constants
 *
 * These are stable object references to prevent unnecessary query re-subscriptions.
 * Creating new objects in query options causes React Query to think the query changed,
 * triggering expensive re-subscriptions to Lunora.
 */

/**
 * Lunora's generated pagination args list `endCursor`/`id` as present-but-undefined
 * rather than optional, so they have to be spelled out explicitly.
 */
export const DEFAULT_PAGINATION_OPTS = {
    cursor: null,
    endCursor: undefined,
    id: undefined,
    numItems: 20,
} as const;

export const DEFAULT_MESSAGE_OPTS = {
    cursor: null,
    endCursor: undefined,
    id: undefined,
    numItems: 20,
} as const;

export const THREAD_LIST_PAGINATION_OPTS = {
    cursor: null,
    endCursor: undefined,
    id: undefined,
    numItems: 100,
} as const;
