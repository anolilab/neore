/**
 * Scheduled retry of the analytics (PostHog) erasure after the deletion workflow gave up on it.
 *
 * By then the auth records are gone, so the user cannot file the request again and the timeout
 * sweep ignores failed requests: this is what finishes it. Only the PostHog erasure runs again
 * (idempotent); no step that deletes the user's own data does. Every scheduling, attempt and
 * outcome is a `gdprAuditLog` row and a structured event; the chain and attempt numbers ride in
 * the job args and the audit details.
 *
 * A CHAIN is the run of up to five attempts that one failure of the workflow starts: a later
 * workflow re-run that fails again starts chain N+1 with its own attempt 1 and its own cap.
 *
 * The confirmation email: the workflow's failure branch leaves the address on the request while a
 * chain is pending (the job never carries it, so it stays out of the scheduler), the successful
 * attempt mails it from there, and the chain's end minimises it: success (completing the request
 * and minimising are one transaction, so a request is never completed with the address still on
 * it) or exhaustion. The address is therefore kept for the length of the chain, about 79 hours.
 *
 * A watchdog scheduled when an attempt starts fails an attempt that stopped without recording an
 * outcome (crash or timeout), which no redelivery would otherwise resume.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { claimOnce, hasClaim } from "../lib/claim-once";
import { HttpError } from "../lib/fetch-timeout";
import { gdprLogger } from "../lib/logger";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import {
    EXPORT_EXPIRY_MS,
    POSTHOG_FAILED_MESSAGE,
    POSTHOG_RETRY_DELAYS_MS,
    POSTHOG_RETRY_LEASE_MS,
    POSTHOG_RETRY_MAX_ATTEMPTS,
    POSTHOG_RETRY_WATCHDOG_MS,
} from "./constants";
import { erasePostHogPerson } from "./steps/posthog-steps";
import { minimiseUserRecords } from "./steps/residual-deletion-steps";

interface RetryTarget {
    attempt: number;
    /** Which failure of the workflow started this run of attempts: 1 for the first, 2 for a re-run that failed again. */
    chain: number;
    requestId: Id<"gdprRequests">;
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

/**
 * Claim-once scopes (`lib/claim-once.ts`) that keep each step of an attempt at-most-once. The keys
 * are `<requestId>:<chain>:<attempt>`, non-personal, and deliberately NOT tagged with the user: erasing the
 * account must not erase the memory that stops a redelivered attempt from running again.
 */
const SCHEDULED_SCOPE = "posthog-retry-scheduled";
const STARTED_SCOPE = "posthog-retry-started";
/** How an attempt ends: once its outcome is claimed (failed, succeeded or exhausted), that attempt never runs again. */
const OUTCOME_SCOPE = "posthog-retry-outcome";
/** Who is running an attempt right now: held for `POSTHOG_RETRY_LEASE_MS`, so a second delivery stays out and a dead one can be replaced. */
const LEASE_SCOPE = "posthog-retry-lease";
/** Past the whole retry chain (about 79 hours) plus the scheduler's redelivery window. */
const ATTEMPT_CLAIM_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const attemptKey = ({ attempt, chain, requestId }: RetryTarget): string => `${requestId}:${String(chain)}:${String(attempt)}`;

/** Queues one attempt, once: a redelivered caller finds the attempt's claim and queues nothing. */
const scheduleAttempt = async (context: MutationCtx, target: RetryTarget): Promise<void> => {
    const { attempt, chain, requestId, userId } = target;

    if (!(await claimOnce(context, SCHEDULED_SCOPE, attemptKey(target), ATTEMPT_CLAIM_TTL_MS))) {
        return;
    }

    const delayMs = POSTHOG_RETRY_DELAYS_MS[attempt - 1] ?? POSTHOG_RETRY_DELAYS_MS[POSTHOG_RETRY_MAX_ATTEMPTS - 1] ?? 0;

    await runAfterOnShard(
        context.scheduler,
        delayMs,
        internal.gdpr.posthog_retry.retryPostHogErasure,
        { attempt, chain, requestId, userId },
        // The job must run on the user's shard, where the request rows live.
        userId,
    );
    await record(context, "deletion_retry_scheduled", userId, { attempt, chain, requestId });
};

/**
 * The chain a failure starts: how many times the workflow logged `deletion_failed` for this request.
 * The workflow writes that row before it calls `schedulePostHogRetry`, so the failure being handled
 * is already counted (hence the floor of 1), and a redelivery of this call reads the same number,
 * because nothing in a chain writes the row.
 */
const chainOf = async (context: MutationCtx, requestId: string, userId: string): Promise<number> => {
    const rows = await context.db
        .query("gdprAuditLog")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
    const failures = rows.filter((row) => {
        if (row.action !== "deletion_failed") {
            return false;
        }

        try {
            return (JSON.parse(row.details) as { requestId?: unknown }).requestId === requestId;
        } catch {
            return false;
        }
    });

    return Math.max(1, failures.length);
};

/**
 * Called by the deletion workflow when the PostHog step is exhausted: queues retry 1 of a new chain. The request
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

        await scheduleAttempt(context, { ...args, attempt: 1, chain: await chainOf(context, args.requestId, args.userId) });

        return null;
    });

/**
 * Claims an attempt: a request still `failed` is retried, so one that was completed meanwhile
 * (a re-run workflow) or cancelled is left alone. An attempt that already has its outcome row
 * (failed, succeeded, exhausted) never runs again: a redelivery after that commit would otherwise
 * call the provider a second time and fork the chain with a second successor. A `processing`
 * request is taken over only when THIS attempt claimed it, i.e. the job was redelivered after the action stopped mid-run, and
 * only once the running delivery's lease has lapsed: a delivery that arrives while the lease is
 * held does nothing, so two deliveries never race to record the outcome. A request a workflow
 * re-run holds as `processing` has no such row and is left alone.
 */
export const startPostHogRetry = internalMutation
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args: { attempt, chain, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId) {
            return false;
        }

        const key = attemptKey({ attempt, chain, requestId, userId });

        if (await hasClaim(context, OUTCOME_SCOPE, key)) {
            return false;
        }

        if (request.status === "processing") {
            if (!(await hasClaim(context, STARTED_SCOPE, key))) {
                return false;
            }

            if (!(await claimOnce(context, LEASE_SCOPE, key, POSTHOG_RETRY_LEASE_MS))) {
                return false;
            }

            await record(context, "deletion_retry_resumed", userId, { attempt, chain, requestId });

            return true;
        }

        if (request.status !== "failed") {
            return false;
        }

        await claimOnce(context, STARTED_SCOPE, key, ATTEMPT_CLAIM_TTL_MS);
        await claimOnce(context, LEASE_SCOPE, key, POSTHOG_RETRY_LEASE_MS);
        await context.db.patch(request._id, { status: "processing" });
        await record(context, "deletion_retry_started", userId, { attempt, chain, requestId });
        // Only a fresh start: a resume is the same attempt, already watched. The job and the claim
        // commit together, so an attempt that started always has its watchdog.
        await runAfterOnShard(
            context.scheduler,
            POSTHOG_RETRY_WATCHDOG_MS,
            internal.gdpr.posthog_retry.expireStalePostHogRetry,
            { attempt, chain, requestId, userId },
            userId,
        );

        return true;
    });

/**
 * An attempt failed: back to `failed` with the fixed reason, then the next attempt or the end of the
 * schedule. Only a request still `processing` is moved: one completed or cancelled meanwhile stays
 * so, and a duplicate delivery that finds it already `failed` queues no second chain. The last
 * attempt's failure ends the chain, so it minimises the records here, in the same transaction
 * (minimisation clears the free-text reason, hence the fixed one is written after it).
 */
const failAttempt = async (context: MutationCtx, target: RetryTarget, errorClass: string): Promise<void> => {
    const { attempt, chain, requestId, userId } = target;
    const request = await context.db.get(requestId);

    if (request?.userId !== userId || request.status !== "processing") {
        return;
    }

    if (!(await claimOnce(context, OUTCOME_SCOPE, attemptKey(target), ATTEMPT_CLAIM_TTL_MS))) {
        return;
    }

    const isLast = attempt >= POSTHOG_RETRY_MAX_ATTEMPTS;

    if (isLast) {
        await minimiseUserRecords(context, userId);
    }

    await context.db.patch(requestId, { errorMessage: POSTHOG_FAILED_MESSAGE, status: "failed" });
    await record(context, "deletion_retry_failed", userId, { attempt, chain, errorClass, requestId });

    if (!isLast) {
        await scheduleAttempt(context, { attempt: attempt + 1, chain, requestId, userId });

        return;
    }

    await record(context, "deletion_retry_exhausted", userId, { attempt, chain, requestId });
    gdprLogger.error(`Analytics erasure for request ${requestId} still failing after ${String(attempt)} retries; giving up`);
};

export const failPostHogRetry = internalMutation
    .input({
        attempt: v.number(),
        chain: v.number(),
        errorClass: v.string().max(MAX_LENGTH.id),
        requestId: v.id("gdprRequests"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { errorClass, ...target }, ctx: context }) => {
        await failAttempt(context, target, errorClass);

        return null;
    });

/**
 * The watchdog an attempt's start schedules. An attempt that stopped before recording an outcome
 * (crash or timeout) is never redelivered, and would leave the request `processing` until the
 * 30-day sweep: this fails it like any failed attempt, so the next one is queued or the chain
 * ends. It does nothing when the attempt has an outcome, or never started.
 */
export const expireStalePostHogRetry = internalMutation
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const key = attemptKey(args);

        if ((await hasClaim(context, OUTCOME_SCOPE, key)) || !(await hasClaim(context, STARTED_SCOPE, key))) {
            return null;
        }

        await failAttempt(context, args, "watchdog");

        return null;
    });

/**
 * The address the confirmation email goes to: the one still stored on a request that has not ended.
 * Empty when it was minimised already (nothing to mail), the request is not this user's, or it
 * ended meanwhile (a workflow re-run mails its own).
 */
export const getRetryConfirmationEmail = internalQuery
    .input({ requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.string())
    .query(async ({ args: { requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        return request?.userId === userId && request.status === "processing" ? request.userEmail : "";
    });

/**
 * Completes the request the way the workflow's success path does, records the attempt plus the
 * same `deletion_completed` outcome, and minimises the records (the confirmation email has been
 * sent by now), in ONE transaction: a failure leaves it `processing` for the redelivered job to
 * finish, and a request completed or cancelled meanwhile is neither changed nor recorded twice.
 */
export const recordPostHogRetrySuccess = internalMutation
    .input({
        attempt: v.number(),
        chain: v.number(),
        posthog: v.union(v.literal("deleted"), v.literal("no_profile")),
        requestId: v.id("gdprRequests"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { attempt, chain, posthog, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId || (request.status !== "processing" && request.status !== "failed")) {
            return null;
        }

        if (!(await claimOnce(context, OUTCOME_SCOPE, attemptKey({ attempt, chain, requestId, userId }), ATTEMPT_CLAIM_TTL_MS))) {
            return null;
        }

        await context.db.patch(requestId, { completedAt: context.now, expiresAt: context.now + EXPORT_EXPIRY_MS, progress: 100, status: "completed" });
        await record(context, "deletion_retry_succeeded", userId, { attempt, chain, posthog, requestId });
        await record(context, "deletion_completed", userId, { posthog, requestId });
        await minimiseUserRecords(context, userId);

        return null;
    });

/** A retry that finds analytics erasure unconfigured erased nothing: it fails like any other attempt. `name` becomes the audited error class. */
class PostHogUnconfiguredError extends Error {
    override readonly name = "unconfigured";
}

export const retryPostHogErasure = internalAction
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .action(async ({ args, ctx: context }) => {
        if (!(await context.runMutation(internal.gdpr.posthog_retry.startPostHogRetry, args))) {
            return null;
        }

        let posthog: Awaited<ReturnType<typeof erasePostHogPerson>>;

        try {
            posthog = await erasePostHogPerson(args.userId, process.env);

            // The key or project id was removed since the workflow gave up: nothing was erased, so
            // this must not complete the request. Failing it queues the next attempt as usual.
            if (posthog === "skipped") {
                throw new PostHogUnconfiguredError("PostHog erasure is not configured");
            }

            // The address stays on the request until `recordPostHogRetrySuccess` minimises it, so
            // a failure here (or in a later attempt) still finds it. A failed send fails the attempt.
            const userEmail = await context.runQuery(internal.gdpr.posthog_retry.getRetryConfirmationEmail, {
                requestId: args.requestId,
                userId: args.userId,
            });

            if (userEmail !== "") {
                await context.runAction(internal.gdpr.steps.email_steps.sendDeletionConfirmedEmailAction, { userEmail });
            }
        } catch (error) {
            // Never rethrown: the scheduler would re-run a throwing job within minutes, off the 1h/6h/24h schedule.
            await context.runMutation(internal.gdpr.posthog_retry.failPostHogRetry, { ...args, errorClass: errorClassOf(error) });

            return null;
        }

        // Not caught: a failure here leaves the request `processing`, and the scheduler's redelivery
        // of this job resumes it (`startPostHogRetry`). It must never be recorded as a failed erasure.
        await context.runMutation(internal.gdpr.posthog_retry.recordPostHogRetrySuccess, { ...args, posthog });

        return null;
    });
