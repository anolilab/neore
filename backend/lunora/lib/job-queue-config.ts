/**
 * The jobs queue's settings that `defineQueue` cannot carry (`lunora/queues.ts`
 * holds the rest: names, `maxRetries`, `retryDelay`, the DLQ).
 *
 * Read by `alchemy.run.ts` (the deployed consumer), checked against
 * `backend/wrangler.jsonc` (local dev) by `deploy-bindings.test.ts`, and used by
 * the consumer (the dispatch timeout). Pure data on purpose: `alchemy.run.ts`
 * imports it, and must not pull in the Worker runtime.
 *
 * Kept out of `defineQueue` on purpose: `lunora dev` rewrites every DECLARED
 * tuning field into `wrangler.jsonc` on each start, which would undo the dev
 * overrides below. `maxConcurrency` has been a `defineQueue` field since
 * `@lunora/queue@alpha.97` and needs no dev override, but it stays here while
 * `alchemy.run.ts` spreads this object into the deployed consumer; moving it
 * means reading `jobs.maxConcurrency` there in the same change.
 */

/**
 * Consumer settings for the DEPLOY, in Alchemy's (camelCase) shape.
 *
 * `batchSize: 1` — Cloudflare waits up to `maxWaitTimeMs` only for a batch that
 * is not full, so a batch of one is delivered the moment it is sent: no added
 * latency on a chat reply. Concurrency comes from `maxConcurrency` (separate
 * invocations, up to 250 per queue), and each job gets its own 15-minute
 * invocation.
 */
export const JOBS_QUEUE_CONSUMER = {
    batchSize: 1,
    maxConcurrency: 20,
    maxWaitTimeMs: 1000,
} as const;

/**
 * Where `backend/wrangler.jsonc` (LOCAL dev) deliberately differs from the
 * deploy — and nowhere else; `deploy-bindings.test.ts` checks both halves.
 *
 * Miniflare's queue broker ignores `max_concurrency` and dispatches ONE batch
 * at a time, so with batches of one every local job runs back to back
 * (measured: two 3s agent runs finished 3.1s apart). The consumer
 * (`lunora/queues.ts`) dispatches a batch's messages concurrently, so bigger
 * batches are the only local concurrency there is. The cost is the batch
 * window: a local job waits up to `max_batch_timeout` for its batch to fill.
 */
export const JOBS_QUEUE_DEV_CONSUMER_OVERRIDES = {
    max_batch_size: 10,
    max_batch_timeout: 1,
} as const;

/**
 * How long the consumer waits for one dispatched job before giving up and
 * letting the queue retry it. Under the 15-minute consumer wall-time cap, and
 * well above `@lunora/queue`'s 30-second `message.run` default, which any agent
 * run can exceed (Deep Work, 25 steps, takes minutes).
 */
export const JOB_DISPATCH_TIMEOUT_MS = 14 * 60 * 1000;
