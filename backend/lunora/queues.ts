/**
 * The jobs queue (`@lunora/queue`): agent runs, task rounds, eval cases and
 * coding-agent steps, enqueued with `lib/job-queue.ts:enqueueJob`.
 *
 * Why a queue at all: a `ctx.scheduler` job is dispatched by a SchedulerDO whose
 * alarm keeps at most six in flight and awaits each to the end (root AGENTS.md,
 * "Scheduler"; anolilab/lunora#793 lifted it from one). A queue consumer instead
 * runs up to `maxConcurrency` invocations at once, so one user's agent run no
 * longer holds up everyone else's.
 *
 * The tuning below is what codegen can read (static literals only) and what
 * `lunora dev` reconciles into `wrangler.jsonc`; `alchemy.run.ts` reads the same
 * fields off these exports for the deploy. Batch size and batch wait are NOT
 * declared here: they differ between dev and the deploy on purpose, and a
 * declared field is rewritten on every `lunora dev`. Concurrency is not either,
 * only because the deploy reads it elsewhere (`lib/job-queue-config.ts`).
 *
 * - `maxRetries: 2` — delivery is at-least-once and a failed dispatch is
 *   retried; every job the queue carries is idempotent under redelivery (see
 *   `lib/job-queue.ts`). Cloudflare moves the message to the DLQ after
 *   `maxRetries + 1` deliveries, so this number is the whole policy.
 *   `@lunora/queue` also reads it to spot a message's last delivery.
 * - A dispatch that fails DETERMINISTICALLY (the function answered 400, 403,
 *   404 or 422) is acked and logged by `@lunora/queue` rather than retried
 *   into the DLQ — a retry would fail identically.
 */
import { defineQueue } from "@lunora/queue";

import { withTransportRetry } from "./lib/job-dispatch";
import { JOB_DISPATCH_TIMEOUT_MS } from "./lib/job-queue-config";

/** One job: the function to dispatch, its args, and the shard it runs on (`__root__` when unset). */
export interface JobMessage {
    args: Record<string, unknown>;
    functionPath: string;
    shardKey?: string;
}

export const jobs = defineQueue<JobMessage>({
    deadLetterQueue: "neore-backend-jobs-dlq",
    /**
     * Each message is dispatched through `/_lunora/scheduler/dispatch` — the
     * path the SchedulerDO uses — on the shard it names, and acked on success.
     * A batch's messages run concurrently (local dev batches ten; the deploy
     * batches one and scales by invocations). Every message is settled before
     * the first failure is rethrown, so one slow job cannot be cut short by a
     * sibling's error; the rethrow is what lets `@lunora/queue` retry it (or
     * ack it, for a deterministic failure).
     */
    handler: async (_ctx, batch) => {
        const results = await Promise.allSettled(
            batch.messages.map(async (message) => {
                const { args, functionPath, shardKey } = message.body;

                await withTransportRetry(
                    // `message.run`, not `ctx.run`: it pins the call to this message
                    // (failure attribution, replay dedup). The 30s default timeout
                    // would cut a long agent run short.
                    async () =>
                        await message.run({ __lunoraRef: functionPath }, args, {
                            timeoutMs: JOB_DISPATCH_TIMEOUT_MS,
                            ...(shardKey !== undefined && { shardKey }),
                        }),
                    `${functionPath} (message ${message.id})`,
                );
                message.ack();
            }),
        );
        const failure = results.find((result) => result.status === "rejected");

        if (failure) {
            throw failure.reason;
        }
    },
    maxRetries: 2,
    name: "neore-backend-jobs",
    retryDelay: 5,
});

/** The DLQ, consumed only to log what gave up, then acked. */
export const jobsDeadLetters = defineQueue<JobMessage>({
    handler: (_ctx, batch) => {
        for (const message of batch.messages) {
            console.error(`[jobs] dead-lettered ${message.body?.functionPath ?? "<unknown>"} (message ${message.id})`);
            message.ack();
        }
    },
    maxRetries: 0,
    name: "neore-backend-jobs-dlq",
});
