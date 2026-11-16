/**
 * A chat is locked while it has a passcode. The list reads `lockedAt` as a time when locked, and as `null` or
 * `undefined` when not: both mean unlocked, so every check goes through here rather than comparing with one of them.
 */
export const isThreadLocked = (lockedAt: unknown): boolean => lockedAt !== undefined && lockedAt !== null;
