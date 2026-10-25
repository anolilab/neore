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
 * attempt reads it from there, and the chain's end minimises it: exhaustion, or a success, which
 * completes the request and minimises every record in one transaction EXCEPT this request's address.
 * That one stays until the confirmation is settled (`settleRetryConfirmation`: sent, or given up
 * after a failed send), because a send that stops mid-way is resumed from it. The mail goes out
 * after that success is recorded, at most once per request (a claim the workflow's success path
 * shares), and a failed send is logged only: the erasure it confirms has already succeeded.
 *
 * An attempt is resumable at every point after the erasure: once PostHog answered, a marker is
 * recorded, and a redelivery of the same attempt finishes the success path whatever the lease says
 * (the lease only keeps out a concurrent run that has not erased yet), or resends a confirmation
 * that was claimed but never marked sent.
 *
 * A watchdog armed with every scheduled attempt fails an attempt that stopped before erasing (or never started), and
 * re-queues one that stopped after, so the success path (and its confirmation) still runs. An
 * attempt of an older chain (before a workflow re-run failed again) does nothing at all.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { claimOnce, hasClaim } from "../lib/claim-once";
import { HttpError } from "../lib/fetch-timeout";
import { gdprLogger } from "../lib/logger";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { MAX_LENGTH } from "../lib/validators";
import {
    DELETION_CONFIRMATION_CLAIM_TTL_MS,
    DELETION_CONFIRMATION_EMAIL_SCOPE,
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
/** One claim per failure of the workflow (`<requestId>:<failureId>`): a redelivered scheduling call finds it and starts no second chain. */
const CHAIN_SCOPE = "posthog-retry-chain";
/** `<attemptKey>:<n>`: the n-th time an attempt waited for a workflow re-run that holds the request. */
const DEFER_SCOPE = "posthog-retry-deferred";
/** How many times an attempt waits for a re-run (one lease apart) before it leaves the request to it. */
const MAX_DEFERRALS = 12;
/** The erasure of an attempt is done (PostHog answered): the key carries the answer, so a redelivery needs no second call. */
const ERASED_SCOPE = "posthog-retry-erased";
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
    // Armed with the attempt, not when it starts: an attempt whose job never gets to start (it
    // keeps throwing, or is dead-lettered) is then failed too, and the chain goes on.
    await runAfterOnShard(
        context.scheduler,
        delayMs + POSTHOG_RETRY_WATCHDOG_MS,
        internal.gdpr.posthog_retry.expireStalePostHogRetry,
        { attempt, chain, requestId, userId },
        userId,
    );
    await record(context, "deletion_retry_scheduled", userId, { attempt, chain, requestId });
};

type PostHogOutcome = "deleted" | "no_profile";

/** The parsed details of this request's audit rows of `action`. Details are parsed, never matched as text. */
const auditDetails = async (context: Pick<QueryCtx, "db">, action: string, requestId: string, userId: string): Promise<{ attempt?: unknown }[]> => {
    const rows = await context.db
        .query("gdprAuditLog")
        .withIndex("by_user", (q) => q.eq("userId", userId))
        .collect();
    const matching: { attempt?: unknown }[] = [];

    for (const row of rows) {
        if (row.action !== action) {
            continue;
        }

        try {
            const details = JSON.parse(row.details) as { attempt?: unknown; requestId?: unknown };

            if (details.requestId === requestId) {
                matching.push(details);
            }
        } catch {
            // An unreadable row names no request.
        }
    }

    return matching;
};

const auditCount = async (context: Pick<QueryCtx, "db">, action: string, requestId: string, userId: string): Promise<number> => {
    const matching = await auditDetails(context, action, requestId, userId);

    return matching.length;
};

/**
 * How many chains this request has started: the `deletion_retry_scheduled` rows of attempt 1, which
 * `schedulePostHogRetry` writes itself in the same transaction as the chain, so no best-effort
 * write of the workflow's can skip one. It is also the request's CURRENT chain: an attempt of a lower
 * one belongs to a failure a later re-run has superseded. Nothing before a first chain counts as 0.
 */
const chainCount = async (context: Pick<QueryCtx, "db">, requestId: string, userId: string): Promise<number> => {
    const scheduled = await auditDetails(context, "deletion_retry_scheduled", requestId, userId);

    return scheduled.filter((details) => details.attempt === 1).length;
};

const isStaleChain = async (context: Pick<QueryCtx, "db">, { chain, requestId, userId }: RetryTarget): Promise<boolean> =>
    chain < (await chainCount(context, requestId, userId));

/** What PostHog answered for this attempt, once it did; `null` before. */
const erasedOutcomeOf = async (context: Pick<QueryCtx, "db">, target: RetryTarget): Promise<PostHogOutcome | null> => {
    for (const posthog of ["deleted", "no_profile"] as const) {
        if (await hasClaim(context, ERASED_SCOPE, `${attemptKey(target)}:${posthog}`)) {
            return posthog;
        }
    }

    return null;
};

/**
 * A completed attempt whose confirmation was neither sent nor given up on: it succeeded, the
 * request still holds the address, and no `deletion_confirmation_sent` row names it.
 */
const isConfirmationOwed = async (
    context: Pick<QueryCtx, "db">,
    target: RetryTarget,
    request: { status: string; userEmail: string } | null,
): Promise<boolean> =>
    request?.status === "completed" &&
    request.userEmail !== "" &&
    (await erasedOutcomeOf(context, target)) !== null &&
    (await auditCount(context, "deletion_confirmation_sent", target.requestId, target.userId)) === 0;

/**
 * Called by the deletion workflow when the PostHog step is exhausted: queues retry 1 of a new chain,
 * numbered from the chains this request already has. A call is made once per FAILURE (`failureId`),
 * so a redelivery of it finds the failure's claim and queues nothing more. The request is also moved
 * to `failed` HERE, in the same transaction: the workflow's own status writes are best-effort, and a
 * request they left `processing` could not be claimed by the scheduled attempt, which would end
 * without erasing anything. Only `processing` is moved, and only a request that is `processing` or
 * `failed` gets a chain at all: one completed or cancelled meanwhile stays so and has nothing queued.
 * Answers whether an attempt is queued for this failure. `userEmail` is the workflow's own copy of
 * the address, restored on the request when an earlier chain's end had minimised it.
 */
export const schedulePostHogRetry = internalMutation
    .input({
        failureId: v.string().max(MAX_LENGTH.id),
        requestId: v.id("gdprRequests"),
        userEmail: v.string().max(MAX_LENGTH.short),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.boolean())
    .mutation(async ({ args: { failureId, requestId, userEmail, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId || (request.status !== "processing" && request.status !== "failed")) {
            return false;
        }

        if (request.status === "processing") {
            await context.db.patch(requestId, { errorMessage: POSTHOG_FAILED_MESSAGE, status: "failed" });
        }

        if (await claimOnce(context, CHAIN_SCOPE, `${requestId}:${failureId}`, ATTEMPT_CLAIM_TTL_MS)) {
            // A re-run that fails after an earlier chain ended finds the address minimised: the workflow's
            // own copy goes back on the request for this chain's confirmation (it is minimised again at its end).
            if (request.userEmail === "" && userEmail !== "") {
                await context.db.patch(requestId, { userEmail });
            }

            await scheduleAttempt(context, { attempt: 1, chain: (await chainCount(context, requestId, userId)) + 1, requestId, userId });
        }

        return true;
    });

/**
 * What a delivery of an attempt does: `skip` (nothing), `erase` (call PostHog), `deleted` /
 * `no_profile` (PostHog already answered: finish the success path with that answer) or `confirm`
 * (the attempt succeeded but its confirmation is still owed).
 */
const vStartMode = v.union(v.literal("skip"), v.literal("erase"), v.literal("deleted"), v.literal("no_profile"), v.literal("confirm"));

/**
 * A workflow re-run holds the request (`processing`, and this attempt never started): the attempt
 * waits one lease and tries again instead of being dropped, up to `MAX_DEFERRALS` times, each audited.
 * Past that the attempt is failed (`failAttempt`) and the chain goes on.
 */
const deferAttempt = async (context: MutationCtx, target: RetryTarget): Promise<"skip"> => {
    const { attempt, chain, requestId, userId } = target;

    for (let deferral = 1; deferral <= MAX_DEFERRALS; deferral += 1) {
        if (await claimOnce(context, DEFER_SCOPE, `${attemptKey(target)}:${String(deferral)}`, ATTEMPT_CLAIM_TTL_MS)) {
            await runAfterOnShard(
                context.scheduler,
                POSTHOG_RETRY_LEASE_MS,
                internal.gdpr.posthog_retry.retryPostHogErasure,
                { attempt, chain, requestId, userId },
                userId,
            );
            await record(context, "deletion_retry_deferred", userId, { attempt, chain, deferral, requestId });

            return "skip";
        }
    }

    // A re-run that never finishes must not hold the chain (and the kept address) forever: the attempt
    // fails like any other, without touching the request the re-run owns, so the next one is queued or
    // the chain ends. A later delivery finds the outcome and does nothing.
    await failAttempt(context, target, "deferred", { isRequestKept: true });

    return "skip";
};

/**
 * Claims an attempt: a request still `failed` is retried, so one that was completed meanwhile
 * (a re-run workflow) or cancelled is left alone, and so is an attempt of an older chain. An
 * attempt that already has its outcome row (failed, succeeded, exhausted) never runs again, except
 * that a succeeded one whose confirmation is still owed is resumed for the email alone: a
 * redelivery after that commit would otherwise call the provider a second time and fork the chain
 * with a second successor. An attempt whose erasure is recorded is finished whatever the lease
 * says: the lease only keeps out a concurrent run that has not erased yet. A `processing` request
 * is otherwise taken over only when THIS attempt claimed it, i.e. the job was redelivered after the
 * action stopped mid-run, and only once the running delivery's lease has lapsed. A request a
 * workflow re-run holds as `processing` has no such row and is left alone.
 */
export const startPostHogRetry = internalMutation
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(vStartMode)
    .mutation(async ({ args: { attempt, chain, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId) {
            return "skip";
        }

        const target = { attempt, chain, requestId, userId };

        if (await isStaleChain(context, target)) {
            return "skip";
        }

        const key = attemptKey(target);

        if (await hasClaim(context, OUTCOME_SCOPE, key)) {
            return (await isConfirmationOwed(context, target, request)) ? "confirm" : "skip";
        }

        const erased = await erasedOutcomeOf(context, target);

        if (erased !== null) {
            // `failed` too: a re-run that failed the request under this attempt without starting a
            // newer chain (checked above) leaves nobody else to complete an erasure that is done.
            return request.status === "processing" || request.status === "failed" ? erased : "skip";
        }

        if (request.status === "processing") {
            if (!(await hasClaim(context, STARTED_SCOPE, key))) {
                return await deferAttempt(context, target);
            }

            if (!(await claimOnce(context, LEASE_SCOPE, key, POSTHOG_RETRY_LEASE_MS))) {
                return "skip";
            }

            await record(context, "deletion_retry_resumed", userId, { attempt, chain, requestId });

            return "erase";
        }

        if (request.status !== "failed") {
            return "skip";
        }

        // A run of this attempt began and stopped (a re-run failed the request under it): it is not
        // started again, the watchdog ends it. Both claims must be won for a start to count.
        if (!(await claimOnce(context, STARTED_SCOPE, key, ATTEMPT_CLAIM_TTL_MS)) || !(await claimOnce(context, LEASE_SCOPE, key, POSTHOG_RETRY_LEASE_MS))) {
            return "skip";
        }

        await context.db.patch(request._id, { status: "processing" });
        await record(context, "deletion_retry_started", userId, { attempt, chain, requestId });

        return "erase";
    });

/**
 * PostHog answered for this attempt. Recorded on its own, before the success path, so that a
 * delivery which finds the lease held (the first one died or threw after erasing) can still finish
 * the attempt, and the watchdog never fails an attempt that erased. A claim, not an audit row.
 */
export const recordPostHogErased = internalMutation
    .input({
        attempt: v.number(),
        chain: v.number(),
        posthog: v.union(v.literal("deleted"), v.literal("no_profile")),
        requestId: v.id("gdprRequests"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .mutation(async ({ args: { posthog, ...target }, ctx: context }) => {
        const request = await context.db.get(target.requestId);

        if (request?.userId === target.userId && !(await isStaleChain(context, target))) {
            await claimOnce(context, ERASED_SCOPE, `${attemptKey(target)}:${posthog}`, ATTEMPT_CLAIM_TTL_MS);
        }

        return null;
    });

/**
 * An attempt failed: back to `failed` with the fixed reason, then the next attempt or the end of the
 * schedule. A request that is `processing` or `failed` is written; one completed or cancelled
 * meanwhile stays so, and a duplicate delivery queues no second chain (the outcome is claimed once). The last
 * attempt's failure ends the chain, so it minimises the records here, in the same transaction
 * (minimisation clears the free-text reason, hence the fixed one is written after it).
 */
const failAttempt = async (context: MutationCtx, target: RetryTarget, errorClass: string, { isRequestKept = false } = {}): Promise<void> => {
    const { attempt, chain, requestId, userId } = target;
    const request = await context.db.get(requestId);

    // `failed` counts too: a re-run or a sweep that failed the request under a running attempt must
    // not leave the chain without an outcome, successor or end. Completed and cancelled stay as they are.
    if (request?.userId !== userId || (request.status !== "processing" && request.status !== "failed")) {
        return;
    }

    // A request a newer chain now owns, or an attempt that already erased, is not this attempt's to fail.
    if ((await isStaleChain(context, target)) || (await erasedOutcomeOf(context, target)) !== null) {
        return;
    }

    if (!(await claimOnce(context, OUTCOME_SCOPE, attemptKey(target), ATTEMPT_CLAIM_TTL_MS))) {
        return;
    }

    const isLast = attempt >= POSTHOG_RETRY_MAX_ATTEMPTS;

    if (isLast) {
        await minimiseUserRecords(context, userId);
    }

    if (!isRequestKept) {
        await context.db.patch(requestId, { errorMessage: POSTHOG_FAILED_MESSAGE, status: "failed" });
    }

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
 * The watchdog an attempt's scheduling arms. An attempt that stopped before recording an outcome
 * (crash or timeout) is never redelivered, and would leave the request `processing` until the
 * 30-day sweep: this fails it like any failed attempt, so the next one is queued or the chain
 * ends. One that stopped AFTER PostHog answered is not failed (the erasure succeeded): the attempt
 * is queued again, and finishes its success path and confirmation. It does nothing for an attempt
 * of an older chain, and for one that never started while a re-run holds the request.
 */
export const expireStalePostHogRetry = internalMutation
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args, ctx: context }) => {
        const key = attemptKey(args);

        if (await isStaleChain(context, args)) {
            return null;
        }

        const request = await context.db.get(args.requestId);
        const isFinished = await hasClaim(context, OUTCOME_SCOPE, key);

        if (isFinished ? await isConfirmationOwed(context, args, request) : (await erasedOutcomeOf(context, args)) !== null) {
            await runAfterOnShard(context.scheduler, 0, internal.gdpr.posthog_retry.retryPostHogErasure, args, args.userId);

            return null;
        }

        // An attempt whose job never started is failed too, but only once the request is `failed`
        // again: a `processing` one belongs to a re-run that is still working.
        if (isFinished || (!(await hasClaim(context, STARTED_SCOPE, key)) && request?.status !== "failed")) {
            return null;
        }

        await failAttempt(context, args, "watchdog");

        return null;
    });

/**
 * The address the confirmation email goes to: the one the COMPLETED request still holds (a
 * success keeps it until the confirmation is settled) when no confirmation was recorded as sent.
 * Empty when it was minimised already (nothing to mail), the request is not this user's, or it did
 * not end in a completed deletion.
 */
export const getRetryConfirmationEmail = internalQuery
    .input({ requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.string())
    .query(async ({ args: { requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId || request.status !== "completed") {
            return "";
        }

        return (await auditCount(context, "deletion_confirmation_sent", requestId, userId)) === 0 ? request.userEmail : "";
    });

/**
 * Completes the request the way the workflow's success path does, records the attempt plus the
 * same `deletion_completed` outcome, and minimises the records, in ONE transaction: a failure
 * leaves it `processing` for the redelivered job to finish. The request's own address is the one
 * thing kept, for the confirmation (`settleRetryConfirmation` clears it).
 *
 * `true` only when THIS call completed the request. It does nothing, and says `false`, for a
 * request that is no longer `processing` (a workflow re-run completed, failed or cancelled it, and
 * its own path owns the outcome), for an attempt of an older chain, and for an attempt that has an
 * outcome already. The erasure itself stays recorded (`recordPostHogErased`).
 */
export const recordPostHogRetrySuccess = internalMutation
    .input({
        attempt: v.number(),
        chain: v.number(),
        posthog: v.union(v.literal("deleted"), v.literal("no_profile")),
        requestId: v.id("gdprRequests"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.boolean())
    .mutation(async ({ args: { attempt, chain, posthog, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);
        const target = { attempt, chain, requestId, userId };

        // `failed` is this attempt's to complete too: a newer chain would have made it stale, so a failed
        // request here is one a re-run (or the sweep) failed and nobody else is going to finish.
        if (request?.userId !== userId || (request.status !== "processing" && request.status !== "failed") || (await isStaleChain(context, target))) {
            return false;
        }

        if (!(await hasClaim(context, STARTED_SCOPE, attemptKey(target)))) {
            return false;
        }

        if (!(await claimOnce(context, OUTCOME_SCOPE, attemptKey(target), ATTEMPT_CLAIM_TTL_MS))) {
            return false;
        }

        await context.db.patch(requestId, { completedAt: context.now, expiresAt: context.now + EXPORT_EXPIRY_MS, progress: 100, status: "completed" });
        await record(context, "deletion_retry_succeeded", userId, { attempt, chain, posthog, requestId });
        await record(context, "deletion_completed", userId, { posthog, requestId });
        await minimiseUserRecords(context, userId, requestId);

        return true;
    });

/**
 * The confirmation is settled: sent (recorded, so a redelivery does not mail again), or given up on
 * after a failed send. Either way the address goes now.
 */
export const settleRetryConfirmation = internalMutation
    .input({ isSent: v.boolean(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { isSent, requestId, userId }, ctx: context }) => {
        const request = await context.db.get(requestId);

        if (request?.userId !== userId) {
            return null;
        }

        if (isSent) {
            await record(context, "deletion_confirmation_sent", userId, { requestId });
        }

        await context.db.patch(requestId, { userEmail: "" });

        return null;
    });

/** A retry that finds analytics erasure unconfigured erased nothing: it fails like any other attempt. `name` becomes the audited error class. */
class PostHogUnconfiguredError extends Error {
    override readonly name = "unconfigured";
}

/**
 * Best effort and after the outcome is recorded: the erasure has succeeded whether or not this
 * works, so a failure is logged (error name only) and changes neither the request nor the audit.
 * The claim is shared with the workflow's success path, so whoever sends first wins. It is made
 * before the send and kept: a send that throws is given up on (settling clears the address, so no
 * later sender has one to use), while a send that STOPS leaves the claim without a sent row, which
 * `isResend` (a redelivery of this attempt) treats as not sent and mails again: a duplicate is
 * acceptable, a missing confirmation is not.
 */
const sendConfirmation = async (context: ActionCtx, target: RetryTarget, userEmail: string, isResend: boolean): Promise<void> => {
    const claim = { key: target.requestId, scope: DELETION_CONFIRMATION_EMAIL_SCOPE };
    let isSent = false;
    let isAttempted = false;

    try {
        const isClaimed = await context.runMutation(internal.lib.claim_once.claimKey, { ...claim, ttlMs: DELETION_CONFIRMATION_CLAIM_TTL_MS });

        if (isClaimed || isResend) {
            isAttempted = true;
            await context.runAction(internal.gdpr.steps.email_steps.sendDeletionConfirmedEmailAction, { userEmail });
            isSent = true;
        }
    } catch (error) {
        gdprLogger.error(`Deletion confirmation email for request ${target.requestId} was not sent (${errorClassOf(error)})`);
    }

    // Only a send this invocation made (or tried) settles. A claim that is not ours, or an error before
    // one, leaves the address: the sender holding the claim may still fail, and the watchdog resumes it.
    if (isAttempted) {
        await context.runMutation(internal.gdpr.posthog_retry.settleRetryConfirmation, { isSent, requestId: target.requestId, userId: target.userId });
    }
};

const runAttempt = async (context: ActionCtx, args: RetryTarget, mode: "confirm" | "deleted" | "erase" | "no_profile"): Promise<void> => {
    if (mode !== "confirm") {
        let posthog: PostHogOutcome;

        if (mode === "erase") {
            try {
                const outcome = await erasePostHogPerson(args.userId, process.env);

                // The key or project id was removed since the workflow gave up: nothing was erased, so
                // this must not complete the request. Failing it queues the next attempt as usual.
                if (outcome === "skipped") {
                    throw new PostHogUnconfiguredError("PostHog erasure is not configured");
                }

                posthog = outcome;
                await context.runMutation(internal.gdpr.posthog_retry.recordPostHogErased, { ...args, posthog });
            } catch (error) {
                // Never rethrown: the scheduler would re-run a throwing job within minutes, off the 1h/6h/24h schedule.
                await context.runMutation(internal.gdpr.posthog_retry.failPostHogRetry, { ...args, errorClass: errorClassOf(error) });

                return;
            }
        } else {
            // PostHog already answered for this attempt (a delivery before this one erased, then stopped).
            posthog = mode;
        }

        // Not caught: a failure here leaves the request `processing`, and the scheduler's redelivery
        // of this job finishes it whatever the lease says. It must never be recorded as a failed erasure.
        const isCompleted = await context.runMutation(internal.gdpr.posthog_retry.recordPostHogRetrySuccess, { ...args, posthog });

        // Not this call's outcome: a workflow re-run settled the request and owns its confirmation.
        if (!isCompleted) {
            return;
        }
    }

    // After the success is recorded, so a failed address read is not a failed erasure; a throw
    // here is redelivered as `confirm`.
    const userEmail = await context.runQuery(internal.gdpr.posthog_retry.getRetryConfirmationEmail, {
        requestId: args.requestId,
        userId: args.userId,
    });

    if (userEmail !== "") {
        await sendConfirmation(context, args, userEmail, mode === "confirm");
    }
};

export const retryPostHogErasure = internalAction
    .input({ attempt: v.number(), chain: v.number(), requestId: v.id("gdprRequests"), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .action(async ({ args, ctx: context }) => {
        const mode = await context.runMutation(internal.gdpr.posthog_retry.startPostHogRetry, args);

        if (mode === "skip") {
            return null;
        }

        try {
            await runAttempt(context, args, mode);
        } catch (error) {
            // This delivery holds the lease and is about to throw for a redelivery: hand the lease back,
            // or that redelivery finds it held, does nothing, and the scheduler counts the job as done.
            if (mode === "erase") {
                await context.runMutation(internal.lib.claim_once.releaseKey, { key: attemptKey(args), scope: LEASE_SCOPE }).catch(() => null);
            }

            throw error;
        }

        return null;
    });
