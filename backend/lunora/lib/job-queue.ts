/**
 * Enqueue a job on the jobs queue instead of `ctx.scheduler`.
 *
 * `ctx.scheduler` hands every job to one SchedulerDO that runs them one at a
 * time, each awaited to the end (root AGENTS.md, "Scheduler"). Anything long or
 * latency-critical — an agent run, a task round, an eval case — goes here, and
 * the `jobs` consumer (`lunora/queues.ts`) dispatches it through the same
 * `/_lunora/scheduler/dispatch` endpoint, many at once. Short timed jobs
 * (titles, reapers, crons) stay on the scheduler.
 *
 * ## Every job enqueued here MUST tolerate redelivery
 *
 * Queues deliver at least once: a consumer that times out, crashes or loses its
 * ack gets the message again, possibly while the first delivery is still
 * running. So each target claims its work in a mutation before doing any — a
 * stream's `runClaimedAt` (`chat/streaming/persistent/library.ts:claimStreamRun`),
 * a task round's cycle/round row (`tasks/internal.ts:claimRound`), an eval case's
 * `(runId, index)` row (`evals/internal.ts:claimCase`), a coding-agent run's
 * status or poll sequence (`coding-agents/functions.ts`). A second delivery
 * finds the claim taken and returns without effect, which acks it.
 *
 * A job with no row of its own to claim on — media generation from `/chat/media`
 * — passes `{ once: … }` instead: {@link enqueueJob} stamps a fresh `jobId` and
 * sends the job through `lib/job-once.ts:runJobOnce`, which claims that id
 * (`lib/claim-once.ts`, scope `job`) BEFORE invoking the target, so a
 * redelivery never reaches the paid provider call a second time. The target
 * carries no claim code; it receives the `jobId` only to tag what it creates
 * (the media actions stamp their pending row with it, `chat/media-abandon.ts`).
 *
 * Unlike `ctx.scheduler.runAfter` inside a mutation, an enqueue is not undone if
 * the mutation later fails — another reason the claim, not the enqueue, is what
 * decides whether work happens.
 */
import type { QueueProducer } from "@lunora/queue";
import { createQueueContext, queueBindingName } from "@lunora/queue";
import type { ArgsOf, FunctionReference } from "@lunora/scheduler";
import { env } from "cloudflare:workers";

import { internal } from "../_generated/internal";
import type { JobMessage } from "../queues";
import { currentUserShard } from "./shard-context";

/** The producer binding codegen provisions for the `jobs` export of `lunora/queues.ts`. */
export const JOBS_QUEUE_BINDING = queueBindingName("jobs");

/**
 * The same producer `ctx.queues.jobs` is, built off the Worker env because most
 * callers have no `ctx` that carries it (HTTP actions, auth hooks, code that
 * learns its shard from `shard-context.ts`). A missing binding rejects the send, naming the
 * queue — it never drops an agent run silently.
 */
const jobsQueue = (): QueueProducer =>
    createQueueContext(Object.fromEntries(Object.entries(env)), [{ binding: JOBS_QUEUE_BINDING, exportName: "jobs", name: "neore-backend-jobs" }]).jobs;

/**
 * `ref(args)` on the jobs queue, after `delayMs` (whole seconds; Queues delay
 * natively). The consumer dispatches it to `shardKey` — by default the shard
 * this code is serving (`lib/shard-context.ts`), so a job continues on the
 * shard that holds its rows. Code outside a shard (an HTTP action) must name
 * the owner's shard, or the job runs on `__root__`.
 *
 * `once` routes an ACTION through `runJobOnce` under a fresh `jobId`, for a
 * target that has no claim of its own (see the module comment); `userId` tags
 * the claim so account deletion erases it, and `onLapse` is what runs (with
 * `claimKey` added) if a delivery dies mid-job (`lib/job-once.ts`).
 */
export const enqueueJob = async <F extends FunctionReference>(
    ref: F,
    args: ArgsOf<F>,
    options: {
        delayMs?: number;
        once?: { onLapse?: { args: Record<string, unknown>; ref: { __lunoraRef: string } }; userId?: string };
        shardKey?: string;
    } = {},
): Promise<void> => {
    const delaySeconds = options.delayMs === undefined ? undefined : Math.max(0, Math.ceil(options.delayMs / 1000));
    const shardKey = options.shardKey ?? currentUserShard();
    const message: JobMessage = options.once
        ? {
              args: {
                  args,
                  jobId: crypto.randomUUID(),
                  onLapse: options.once.onLapse && { args: JSON.stringify(options.once.onLapse.args), target: options.once.onLapse.ref.__lunoraRef },
                  target: ref.__lunoraRef,
                  userId: options.once.userId,
              },
              functionPath: internal.lib.job_once.runJobOnce.__lunoraRef,
          }
        : { args: args as Record<string, unknown>, functionPath: ref.__lunoraRef };

    await jobsQueue().send(
        { ...message, ...(shardKey !== undefined && { shardKey }) },
        delaySeconds === undefined || delaySeconds === 0 ? undefined : { delaySeconds },
    );
};
