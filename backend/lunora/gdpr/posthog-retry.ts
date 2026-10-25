/**
 * Scheduled retry of the analytics (PostHog) erasure after the deletion workflow gave up on it.
 *
 * By then the auth records are gone, so the user cannot file the request again and the timeout
 * sweep ignores failed requests: this is what finishes it. Only the PostHog erasure runs again
 * (idempotent); no step that deletes the user's own data does. The confirmation email is NOT
 * sent from here: `minimiseGdprRecords` already erased the address, and carrying it in the job
 * would keep it in the scheduler. Every scheduling, attempt and outcome is a `gdprAuditLog` row
 * and a structured event; the attempt count rides in the job args and the audit details.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation } from "../_generated/server";
import { HttpError } from "../lib/fetch-timeout";
import { gdprLogger } from "../lib/logger";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import { EXPORT_EXPIRY_MS, POSTHOG_FAILED_MESSAGE, POSTHOG_RETRY_DELAYS_MS, POSTHOG_RETRY_MAX_ATTEMPTS } from "./constants";
import { erasePostHogPerson } from "./steps/posthog-steps";

interface RetryTarget {
    attempt: number;
    requestId: string;
    userId: string;
}

/** Non-personal: an error name or `http_<status>`, never the message (it carries the user id and the provider's reply). */
const errorClassOf = (error: unknown): string => {
    if (error instanceof HttpError) {
        return `http_${String(error.status)}`;
    }

    return error instanceof Error ? error.name.slice(0, 64) : "unknown";
};

/** One audit row plus the matching structured event. `details` must stay free of email, user id and provider text. */
const record = async (context: MutationCtx, action: string, userId: string, details: Record<string, string | number>): Promise<void> => {
    await context.db.insert("gdprAuditLog", { action, details: JSON.stringify(details), performedBy: "system", timestamp: context.now, userId });
    context.log.event(`gdpr.${action}`, details);
};

/** Whether the audit log holds one of `actions` for this attempt of this request (the details survive minimisation). */
const hasAttemptRow = async (context: MutationCtx, actions: ReadonlyArray<string>, { attempt, requestId, userId }: RetryTarget): Promise<boolean> => {
    const rows = await context.db
        .query("gdprAuditLog")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();

    return rows.some((row) => {
        if (!actions.includes(row.action)) {
            return false;
        }

        try {
            const logged = JSON.parse(row.details) as { attempt?: unknown; requestId?: unknown };

            return logged.attempt === attempt && logged.requestId === requestId;
        } catch {
            return false;
        }
    });
};

/** How an attempt ends: once one of these is written, that attempt never runs again. */
const OUTCOME_ACTIONS = ["deletion_retry_failed", "deletion_retry_succeeded", "deletion_retry_exhausted"] as const;

/** Queues one attempt, once: a redelivered caller finds its `deletion_retry_scheduled` row and queues nothing. */
const scheduleAttempt = async (context: MutationCtx, target: RetryTarget): Promise<void> => {
    const { attempt, requestId, userId } = target;

    if (await hasAttemptRow(context, ["deletion_retry_scheduled"], target)) {
        return;
    }

    const delayMs = POSTHOG_RETRY_DELAYS_MS[attempt - 1] ?? POSTHOG_RETRY_DELAYS_MS[POSTHOG_RETRY_MAX_ATTEMPTS - 1] ?? 0;

    await runAfterOnShard(
        context.scheduler,
        delayMs,
        internal.gdpr.posthog_retry.retryPostHogErasure,
        { attempt, requestId, userId },
        // The job must run on the user's shard, where the request rows live.
        userId,
    );
    await record(context, "deletion_retry_scheduled", userId, { attempt, requestId });
};

/**
 * Called by the deletion workflow when the PostHog step is exhausted: queues retry 1. The request
 * is also moved to `failed` HERE, in the same transaction: the workflow's own status writes are
 * best-effort, and a request they left `processing` could not be claimed by the scheduled attempt,
 * which would end without erasing anything. Only `processing` is moved, so a request completed or
 * cancelled meanwhile stays so.
 */
export const schedulePostHogRetry = internalMutation
    .input({ requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const request = await context.db.get(args.requestId);

        if (request?.userId === args.userId && request.status === "processing") {
            await context.db.patch(args.requestId, { errorMessage: POSTHOG_FAILED_MESSAGE, status: "failed" });
        }

        await scheduleAttempt(context, { ...args, attempt: 1 });

        return null;
    });

/**
 * Claims an attempt: a request still `failed` is retried, so one that was completed meanwhile
 * (a re-run workflow) or cancelled is left alone. An attempt that already has its outcome row
 * (failed, succeeded, exhausted) never runs again: a redelivery after that commit would otherwise
 * call the provider a second time and fork the chain with a second successor. A `processing`
 * request is taken over only when THIS attempt claimed it, i.e. the job was redelivered after the action stopped mid-run: the
 * erasure is idempotent, so a concurrent duplicate is harmless. A request a workflow re-run holds
 * as `processing` has no such row and is left alone.
 */
export const startPostHogRetry = internalMutation
    .input({ attempt: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args: { attempt, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId) {
            return false;
        }

        const target = { attempt, requestId, userId };

        if (await hasAttemptRow(context, OUTCOME_ACTIONS, target)) {
            return false;
        }

        if (request.status === "processing") {
            if (!(await hasAttemptRow(context, ["deletion_retry_started"], target))) {
                return false;
            }

            await record(context, "deletion_retry_resumed", userId, { attempt, requestId });

            return true;
        }

        if (request.status !== "failed") {
            return false;
        }

        await context.db.patch(request._id, { status: "processing" });
        await record(context, "deletion_retry_started", userId, { attempt, requestId });

        return true;
    });

/**
 * An attempt failed: back to `failed` with the fixed reason, then the next attempt or the end of the
 * schedule. Only a request still `processing` is moved: one completed or cancelled meanwhile stays
 * so, and a duplicate delivery that finds it already `failed` queues no second chain.
 */
export const failPostHogRetry = internalMutation
    .input({ attempt: v.number(), errorClass: v.string().max(MAX_LENGTH.id), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { attempt, errorClass, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId || request.status !== "processing") {
            return null;
        }

        await context.db.patch(requestId, { errorMessage: POSTHOG_FAILED_MESSAGE, status: "failed" });
        await record(context, "deletion_retry_failed", userId, { attempt, errorClass, requestId });

        if (attempt < POSTHOG_RETRY_MAX_ATTEMPTS) {
            await scheduleAttempt(context, { attempt: attempt + 1, requestId, userId });

            return null;
        }

        await record(context, "deletion_retry_exhausted", userId, { attempt, requestId });
        gdprLogger.error(`Analytics erasure for request ${requestId} still failing after ${String(attempt)} retries; giving up`);

        return null;
    });

/**
 * Completes the request the way the workflow's success path does and records the attempt plus the
 * same `deletion_completed` outcome, in ONE transaction: a failure leaves it `processing` for the
 * redelivered job to finish, and a request completed or cancelled meanwhile is neither changed nor recorded twice.
 */
export const recordPostHogRetrySuccess = internalMutation
    .input({
        attempt: v.number(),
        posthog: v.union(v.literal("deleted"), v.literal("no_profile"), v.literal("skipped")),
        requestId: v.id("gdprRequests"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { attempt, posthog, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId || (request.status !== "processing" && request.status !== "failed")) {
            return null;
        }

        await context.db.patch(requestId, { completedAt: context.now, expiresAt: context.now + EXPORT_EXPIRY_MS, progress: 100, status: "completed" });
        await record(context, "deletion_retry_succeeded", userId, { attempt, posthog, requestId });
        await record(context, "deletion_completed", userId, { posthog, requestId });

        return null;
    });

export const retryPostHogErasure = internalAction
    .input({ attempt: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .action(async ({ args, ctx: context }) => {
        if (!(await context.runMutation(internal.gdpr.posthog_retry.startPostHogRetry, args))) {
            return null;
        }

        let posthog: Awaited<ReturnType<typeof erasePostHogPerson>>;

        try {
            posthog = await erasePostHogPerson(args.userId, process.env);
        } catch (error) {
            // The failed request must not keep the email either: a minimisation that failed on the
            // workflow's failure branch is retried by every attempt. Best-effort, and before the
            // fail write, which restores the fixed reason that minimisation clears.
            try {
                await context.runMutation(internal.gdpr.steps.residual_deletion_steps.minimiseGdprRecords, { userId: args.userId });
            } catch (minimiseError) {
                gdprLogger.warn(`Minimising the records of request ${args.requestId} failed after a failed analytics erasure retry`, minimiseError);
            }

            // Never rethrown: the scheduler would re-run a throwing job within minutes, off the 1h/6h/24h schedule.
            await context.runMutation(internal.gdpr.posthog_retry.failPostHogRetry, { ...args, errorClass: errorClassOf(error) });

            return null;
        }

        // Not caught: a failure here leaves the request `processing`, and the scheduler's redelivery
        // of this job resumes it (`startPostHogRetry`). It must never be recorded as a failed erasure.
        await context.runMutation(internal.gdpr.posthog_retry.recordPostHogRetrySuccess, { ...args, posthog });

        // As on the workflow's success path, after the final audit write. Best-effort: the request is complete.
        try {
            await context.runMutation(internal.gdpr.steps.residual_deletion_steps.minimiseGdprRecords, { userId: args.userId });
        } catch (error) {
            gdprLogger.warn(`Minimising the records of request ${args.requestId} failed after its analytics erasure retry`, error);
        }

        return null;
    });
