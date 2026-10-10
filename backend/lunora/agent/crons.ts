/**
 * Cron job handlers for agent cleanup tasks.
 * Migrated from `@neore/backend-agent` component.
 *
 * The registrations and handlers live in `lunora/crons.ts`. Expired temporary
 * chats are found through `internal.agent.threads.getExpiredTemporaryThreadIds`
 * (the `by_expiresAt` index) and removed with
 * `internal.agent.threads.deleteAllForThreadIdAsync`, which also drops each
 * thread's `temporaryThreads` marker.
 */

export {};
