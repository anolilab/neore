/**
 * Event triggers: "tell me when" watchers that cost no model call until they fire.
 *
 * A watcher is a `triggers` row of type `event` with a condition (`eventSource`) and what the last check
 * left behind (`eventState`). `nextTriggerAt` is its next check, which is how the shard tick finds it
 * (`lib/shard-housekeeping.ts`), exactly as it finds a schedule.
 *
 * - {@link dispatchDueEventTriggers} (shard tick and housekeeping sweep) leases each due watcher — it moves
 *   `nextTriggerAt` out by a few minutes — and schedules {@link runEventCheck}, so a second tick finds nothing due.
 * - {@link runEventCheck} (an action: pages and other users' threads are outbound calls) asks the source whether
 *   the condition just became true. No model is involved.
 * - {@link recordEventCheck} stores the new baseline, counts failures and, when the condition fired, claims
 *   that occurrence once (`lib/claim-once.ts`) and schedules {@link startEventRun}, which puts the ordinary
 *   trigger run (`executeTrigger`) on the jobs queue.
 *
 * Sources live in `event-sources/`; this file knows none of their details.
 */
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { grantOwnerForThread } from "../agent/sharing";
import { resolveThreadReadAccess } from "../agent/thread-read-access";
import { STREAM_TTL_MS } from "../chat/streaming/persistent/library";
import { claimOnce } from "../lib/claim-once";
import { callOnShard } from "../lib/cross-shard";
import { enqueueJob } from "../lib/job-queue";
import { patchRow } from "../lib/patch";
import { noteShardDue } from "../lib/shard-housekeeping";
import { MAX_LENGTH } from "../lib/validators";
import { notifyQuietly } from "../notifications/notify";
import { advanceStreak } from "./failure-streak";
import { buildEventPayload, checkEvent, checkIntervalMs, cooldownMs, firstCheckAt, watchesSomethingElse } from "./event-sources";
import { EventCheckError, isOwnerFixableCheckFailure } from "./event-sources/check-failure";
import { fetchWatchedPage } from "./event-sources/fetch-page";
import { scanThreadRows } from "./event-sources/thread-scan";
import type { ScanRow } from "./event-sources/thread-scan";
import type { EventCheckContext, ThreadScan } from "./event-sources/types";
import { MAX_ACTIVE_EVENT_WATCHERS, MINUTE_MS } from "./event-sources/types";
import type { EventState } from "./validators";
import { vEventSource, vEventState } from "./validators";

type PendingRun = NonNullable<EventState["pendingRun"]>;

/** Claim scope for "this occurrence already started a run" (`claimOnce`). */
export const EVENT_FIRE_SCOPE = "event-fire";
/**
 * Long enough to cover duplicate ticks and checks of one occurrence, shorter than the smallest interval, so an
 * occurrence that really repeats (a page that changes back and forth) is not refused.
 */
export const EVENT_FIRE_CLAIM_TTL_MS = 4 * MINUTE_MS;
/** A dispatched check that never reports back is retried after this long. */
export const EVENT_CHECK_LEASE_MS = 5 * MINUTE_MS;
const EVENT_DISPATCH_BATCH = 25;
/** A send the jobs queue refused is tried again after this long, doubling each time, up to {@link EVENT_RUN_MAX_ATTEMPTS} tries. */
const EVENT_RUN_RETRY_MS = 2 * MINUTE_MS;

export const EVENT_RUN_MAX_ATTEMPTS = 6;
/**
 * A firing still waiting for the queue after this long is presumed dead (the action that would have settled it was
 * evicted): a newer occurrence replaces it instead of being folded into it. Past the last retry's wait by design.
 */
export const EVENT_PENDING_RUN_HORIZON_MS = EVENT_RUN_RETRY_MS * 2 ** EVENT_RUN_MAX_ATTEMPTS;
/** Rows read per scan of a thread. A longer stretch is read over several checks: the baseline moves to the last row read. */
const THREAD_SCAN_ROWS = 60;
/** The longest a transient failure delays the next check. */
const EVENT_MAX_BACKOFF_MS = 6 * 60 * MINUTE_MS;

/** The failure recorded for a check that was dispatched and never reported back. */
const UNREPORTED_CHECK_ERROR = "The last check did not finish (it ran out of time or memory).";

/** What the owner is told when repeated failed checks switch the watcher off. */
const pausedWatcherNoticeBody = (error: string): string =>
    `Stopped watching after repeated failed checks. Fix the cause and turn the trigger back on. Last error: ${error}`;

// ─── Arming (called when an event trigger is switched on or its condition changes) ───

/** The baseline and first check of a watcher that is being switched on. Refuses one that cannot work. */
export const armEventTrigger = (trigger: Doc<"triggers">, now: number): { eventState: EventState; nextTriggerAt: number } => {
    const config = trigger.eventSource;

    if (!config) {
        throw new LunoraError("BAD_REQUEST", "This event trigger has no condition to watch. Delete it and create a new one.");
    }

    if (config.kind === "time" && config.at <= now) {
        throw new LunoraError("BAD_REQUEST", "That moment has already passed. Pick a new one.");
    }

    // `armedAt` is the generation of this arming: a check that began under an earlier one is dropped (`recordEventCheck`).
    return { eventState: { armedAt: now }, nextTriggerAt: firstCheckAt(config, now) };
};

/** A user keeps at most {@link MAX_ACTIVE_EVENT_WATCHERS} watchers switched on: each is checked every few minutes. */
export const assertWatcherCapacity = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const switchedOn = await ctx.db
        .query("triggers")
        .withIndex("by_userId_type_enabled", (q) => q.eq("userId", userId).eq("type", "event").eq("enabled", true))
        .take(MAX_ACTIVE_EVENT_WATCHERS);

    if (switchedOn.length >= MAX_ACTIVE_EVENT_WATCHERS) {
        throw new LunoraError("BAD_REQUEST", `You can have ${String(MAX_ACTIVE_EVENT_WATCHERS)} event triggers switched on at a time. Turn one off first.`);
    }
};

/**
 * A thread can be watched by someone who may read it: the owner, or a person it was shared with. The grant
 * is all the owner's shard can say from here (the rows live on the sharer's shard); every check re-reads the
 * thread's access there.
 */
export const assertThreadWatchable = async (ctx: Pick<MutationCtx, "db">, threadId: string, userId: string): Promise<void> => {
    const access = await resolveThreadReadAccess(ctx, threadId as Id<"threads">, userId).catch(() => null);

    if (access?.kind === "full" || (await grantOwnerForThread(ctx, threadId, userId).catch(() => null)) !== null) {
        return;
    }

    throw new LunoraError("NOT_FOUND", "Thread not found");
};

/** The baseline without the run waiting for the queue, which {@link settleEventRun} alone ends. */
const withoutPendingRun = (state: EventState | undefined): EventState => {
    const kept = { ...state };

    delete kept.pendingRun;

    return kept;
};

/** The baseline without the counters of failed checks and the stamp of the lease that was taken for this check. */
const withoutCheckMarks = (state: EventState | undefined): EventState => {
    const kept = { ...state };

    delete kept.checkFailures;
    delete kept.checkRetries;
    delete kept.leasedAt;

    return kept;
};

/** The run waiting for the queue after an occurrence: the earlier one with the newer folded in, or the newer one alone. */
const nextPending = (pending: PendingRun | undefined, fold: boolean, fresh: PendingRun): PendingRun =>
    fold && pending ? { ...pending, coalesced: (pending.coalesced ?? 0) + 1 } : fresh;

/** When a watcher is looked at next after a check that worked; `undefined` for a moment that has come. */
const nextCheckAfterSuccess = (
    config: NonNullable<Doc<"triggers">["eventSource"]>,
    { fired, interval, now, started }: { fired: boolean; interval: number; now: number; started: boolean },
): number | undefined => {
    if (config.kind === "time") {
        // Dispatched early, a moment looks again at its time, but never sooner than a minute from now.
        return fired ? undefined : Math.max(config.at, now + MINUTE_MS);
    }

    return now + (started ? Math.max(interval, cooldownMs(config)) : interval);
};

/**
 * Counts one failed check against a watcher and sets its next look: a failure the owner can fix counts toward the pause
 * (and the third in a row switches the watcher off and tells its owner), an outage backs the next check off instead.
 * Shared by a check that reported a failure and by a lease that lapsed without any report.
 */
const failCheck = async (ctx: MutationCtx, trigger: Doc<"triggers">, error: string, transient: boolean): Promise<void> => {
    const { now } = ctx;
    const interval = Math.max(checkIntervalMs(trigger.eventSource!), EVENT_CHECK_LEASE_MS);
    const retries = transient ? (trigger.eventState?.checkRetries ?? 0) + 1 : 0;
    const { pause, streak } = advanceStreak(trigger.eventState?.checkFailures ?? 0, transient ? "transient" : "user-fixable");
    // An outage waits twice as long after each check it spoils, up to a cap; a failure the owner must fix keeps the usual pace until the pause.
    const wait = retries > 0 ? Math.min(interval * 2 ** (retries - 1), Math.max(EVENT_MAX_BACKOFF_MS, interval)) : interval;
    const counters = { ...(streak > 0 && { checkFailures: streak }), ...(retries > 0 && { checkRetries: retries }) };

    await patchRow(ctx.db, trigger, {
        eventState: { ...withoutCheckMarks(trigger.eventState), checkedAt: now, ...counters },
        lastError: error,
        nextTriggerAt: pause ? undefined : now + wait,
        updatedAt: now,
        ...(pause && { enabled: false }),
    });

    if (!pause) {
        await noteShardDue(ctx, now + wait, trigger.userId);

        return;
    }

    console.info(`[Triggers] Event trigger ${trigger._id} paused after ${streak} failed checks in a row`);
    await notifyQuietly(ctx, {
        body: pausedWatcherNoticeBody(error),
        dedupeKey: `trigger-paused:${trigger._id}:${now}`,
        link: "/dashboard/settings/chat/triggers",
        outcome: "failure",
        title: trigger.name,
        type: "trigger",
        userId: trigger.userId,
    });
};

// ─── Dispatch ────────────────────────────────────────────────────────────────

/**
 * On a user shard: starts the check of every watcher that is due. The lease is taken here, in the same
 * transaction, so a duplicate tick (or the housekeeping sweep running beside the minute tick) dispatches nothing twice.
 */
export const dispatchDueEventTriggers = internalMutation
    .input({})
    .output(v.object({ dispatched: v.number() }))
    .mutation(async ({ ctx }) => {
        const { now } = ctx;
        // One more than a batch says whether a batch is left over. `gt(0)` leaves out a watcher with no next check — a
        // moment that has fired and waits for its run — which sorts before every number and would be dispatched again.
        const due = await ctx.db
            .query("triggers")
            .withIndex("by_type_enabled_nextTriggerAt", (q) => q.eq("type", "event").eq("enabled", true).gt("nextTriggerAt", 0).lte("nextTriggerAt", now))
            .take(EVENT_DISPATCH_BATCH + 1);
        let dispatched = 0;

        for (const trigger of due.slice(0, EVENT_DISPATCH_BATCH)) {
            if (!trigger.eventSource) {
                // A row from before event triggers worked: nothing to watch.
                await patchRow(ctx.db, trigger, {
                    enabled: false,
                    lastError: "This event trigger has no condition to watch.",
                    nextTriggerAt: undefined,
                    updatedAt: now,
                });

                continue;
            }

            // Still stamped: the check of the last lease never reported (it died, e.g. on the CPU limit). That counts as a
            // failed check the owner can fix, so a page that kills every check ends up paused instead of retried for good.
            if (trigger.eventState?.leasedAt !== undefined) {
                await failCheck(ctx, trigger, UNREPORTED_CHECK_ERROR, false);

                continue;
            }

            try {
                await ctx.scheduler.runAfter(0, internal.triggers.events.runEventCheck, { triggerId: trigger._id });
            } catch (error) {
                console.error(`[Triggers] Could not schedule the check of trigger ${trigger._id}; it stays due for the next tick`, error);

                continue;
            }

            await ctx.db.patch(trigger._id, { eventState: { ...trigger.eventState, leasedAt: now }, nextTriggerAt: now + EVENT_CHECK_LEASE_MS });
            dispatched += 1;
        }

        // The lease may lapse with nobody listening (a check that dies, a sweep that ran instead of the tick): wake the shard then.
        if (dispatched > 0) {
            await noteShardDue(ctx, now + EVENT_CHECK_LEASE_MS, due[0]!.userId);
        }

        if (due.length > EVENT_DISPATCH_BATCH) {
            await noteShardDue(ctx, now, due[0]!.userId);
        }

        return { dispatched };
    });

// ─── The check ───────────────────────────────────────────────────────────────

/**
 * What a thread holds past a baseline, for the watcher `userId`. Runs on the shard the thread's rows live on
 * (its owner's), and reads the thread only if `userId` may: a grant can be revoked between checks.
 */
export const latestThreadReply = internalQuery
    .input({
        after: v.optional(v.object({ order: v.number(), stepOrder: v.number() })),
        // The time of the check (a query has no clock of its own): a reply pending since before the stream timeout is abandoned.
        now: v.number(),
        threadId: v.string().max(MAX_LENGTH.id),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(
        v.object({
            accessible: v.boolean(),
            baseline: v.optional(v.object({ order: v.number(), stepOrder: v.number() })),
            reply: v.optional(v.object({ id: v.string(), text: v.string() })),
        }),
    )
    .query(async ({ args: { after, now, threadId, userId }, ctx }): Promise<ThreadScan & { accessible: boolean }> => {
        const access = await resolveThreadReadAccess(ctx, threadId as Id<"threads">, userId);

        if (access?.kind !== "full" || access.thread.deleted === true) {
            return { accessible: false };
        }

        const id = threadId as Id<"threads">;
        // A first look needs only the newest rows; a later one the rows past the baseline.
        const newest =
            after === undefined
                ? await ctx.db
                      .query("messages")
                      .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", id))
                      .order("desc")
                      .take(20)
                : [];
        const rows = after === undefined ? newest.toReversed() : await rowsAfter(ctx, id, after);
        const scanRows: ScanRow[] = rows.map((row) => {
            const message = row.message as { content?: unknown; role?: string } | undefined;

            return {
                _id: row._id as string,
                createdAt: row._creationTime,
                order: row.order,
                role: message?.role,
                status: row.status,
                stepOrder: row.stepOrder,
                text: row.text ?? textOf(message?.content),
                tool: row.tool,
                userId: row.userId,
            };
        });

        return { accessible: true, ...scanThreadRows(scanRows, after, userId, now - STREAM_TTL_MS) };
    });

/**
 * The rows past a baseline, oldest first: the rest of the baseline's own order by `stepOrder` (one reply can be
 * many rows long), then the later orders. A single read of everything from that order on would hand back the
 * same first rows on every check once a reply has more than {@link THREAD_SCAN_ROWS} of them, and never see past.
 */
const rowsAfter = async (ctx: Pick<QueryCtx, "db">, id: Id<"threads">, after: { order: number; stepOrder: number }): Promise<Doc<"messages">[]> => {
    const sameOrder = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", id).eq("order", after.order).gt("stepOrder", after.stepOrder))
        .take(THREAD_SCAN_ROWS);

    if (sameOrder.length >= THREAD_SCAN_ROWS) {
        return sameOrder;
    }

    const later = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q) => q.eq("threadId", id).gt("order", after.order))
        .take(THREAD_SCAN_ROWS - sameOrder.length);

    return [...sameOrder, ...later];
};

const textOf = (content: unknown): string | undefined => {
    if (typeof content === "string") {
        return content;
    }

    return Array.isArray(content)
        ? content
              .map((part: unknown) => (part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : ""))
              .join(" ")
              .trim() || undefined
        : undefined;
};

/**
 * One check of a watcher: asks its source, and hands the answer, or the failure, to {@link recordEventCheck}.
 * Everything outside the database comes in through `checkContext`.
 */
export const performEventCheck = async (
    ctx: Pick<ActionCtx, "runMutation">,
    trigger: Pick<Doc<"triggers">, "_id" | "eventSource" | "eventState">,
    checkContext: EventCheckContext,
): Promise<void> => {
    const triggerId = trigger._id;

    // What the check was asked about: an answer for anything else is dropped (`recordEventCheck`).
    const read = { armedAt: trigger.eventState?.armedAt, checkedAt: trigger.eventState?.checkedAt, source: trigger.eventSource! };

    try {
        const result = await checkEvent(checkContext, trigger.eventSource!, trigger.eventState ?? {});

        await ctx.runMutation(internal.triggers.events.recordEventCheck, {
            ...(result.fired && { fire: { key: result.fireKey, summary: result.summary, ...(result.excerpt !== undefined && { excerpt: result.excerpt }) } }),
            read,
            state: result.state,
            triggerId,
        });
    } catch (error) {
        console.warn(`[Triggers] Check of trigger ${triggerId} failed:`, error);
        await ctx.runMutation(internal.triggers.events.recordEventCheck, {
            error: (error instanceof Error ? error.message : "The check failed.").slice(0, 300),
            read,
            // Only a cause the owner can fix counts toward pausing; the rest is tried again later.
            transient: !isOwnerFixableCheckFailure(error),
            triggerId,
        });
    }
};

/** Runs one check of a watcher. */
export const runEventCheck = internalAction
    .input({ triggerId: v.id("triggers") })
    .output(v.null())
    .action(async ({ args: { triggerId }, ctx }) => {
        const trigger = await ctx.runQuery(internal.triggers.functions.getTriggerInternal, { triggerId });

        if (trigger?.type !== "event" || trigger.enabled !== true || !trigger.eventSource) {
            return null;
        }

        const { userId } = trigger;
        const now = Date.now();
        const checkContext: EventCheckContext = {
            fetchPage: fetchWatchedPage,
            now,
            scanThread: async (threadId, after) => {
                const args = { after, now, threadId, userId };
                // A thread somebody shared with the owner lives on that person's shard.
                const owner = await ctx.runQuery(internal.agent.sharing.getGrantOwner, { threadId, userId });
                const scan =
                    owner && owner !== userId
                        ? await callOnShard(internal.triggers.events.latestThreadReply, args, { shardKey: owner })
                        : await ctx.runQuery(internal.triggers.events.latestThreadReply, args);

                if (!scan.accessible) {
                    throw new EventCheckError("You can no longer read the thread this trigger watches.");
                }

                return scan;
            },
        };

        await performEventCheck(ctx, trigger, checkContext);

        return null;
    });

/**
 * Puts the run of one firing on the jobs queue. The job id is taken from the firing, so a repeat of this send
 * is the same run, claimed once (`lib/job-once.ts`).
 */
export const queueEventRun = async ({
    firing,
    payload,
    triggerId,
    userId,
}: {
    firing: number;
    payload: string;
    triggerId: Id<"triggers">;
    userId: string;
}): Promise<void> => {
    await enqueueJob(
        internal.triggers.execute.executeTrigger,
        { firing, payload, triggerId },
        {
            once: {
                jobId: `event:${triggerId}:${String(firing)}`,
                // A delivery that dies after claiming the job is never re-run; a moment it consumed must still be switched off.
                onLapse: { args: { firing, triggerId }, ref: internal.triggers.functions.switchOffConsumedMoment },
                userId,
            },
            shardKey: userId,
        },
    );
};

interface EventRunArgs {
    attempt?: number;
    firing: number;
    payload: string;
    triggerId: Id<"triggers">;
    userId: string;
}

/**
 * Sends the run of a firing that {@link recordEventCheck} claimed. It is scheduled by that mutation, so it exists
 * only if the mutation committed: a queue send made inside the mutation is not undone when the mutation fails, and
 * would start a run for a firing that was never recorded. The firing stays `pendingRun` on the watcher until the
 * queue has accepted it; a refused send is scheduled again with a longer wait ({@link settleEventRun}), so a queue
 * outage costs time, not the occurrence. A firing that is no longer pending (sent, or the watcher was re-armed since) sends nothing.
 */
export const performEventRun = async (ctx: Pick<ActionCtx, "runMutation" | "runQuery">, args: EventRunArgs): Promise<void> => {
    const { attempt = 0, firing, triggerId } = args;

    if (!(await ctx.runQuery(internal.triggers.events.isEventRunPending, { firing, triggerId }))) {
        return;
    }

    try {
        await queueEventRun(args);
    } catch (error) {
        console.error(`[Triggers] Could not queue the run of trigger ${triggerId} (attempt ${String(attempt + 1)})`, error);
        await ctx.runMutation(internal.triggers.events.settleEventRun, { attempt, firing, sent: false, triggerId });

        return;
    }

    await ctx.runMutation(internal.triggers.events.settleEventRun, { attempt, firing, sent: true, triggerId });
};

export const startEventRun = internalAction
    .input({
        attempt: v.optional(v.number()),
        firing: v.number(),
        payload: v.string().max(MAX_LENGTH.text),
        triggerId: v.id("triggers"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        await performEventRun(ctx, args);

        return null;
    });

/** Whether `firing` is still waiting for the queue to take it. */
export const isEventRunPending = internalQuery
    .input({ firing: v.number(), triggerId: v.id("triggers") })
    .output(v.boolean())
    .query(async ({ args: { firing, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        return trigger?.eventState?.pendingRun?.firing === firing;
    });

/**
 * What came of one send of a firing. Accepted: the firing is no longer pending. Refused: the same send is scheduled
 * again with a doubled wait; after {@link EVENT_RUN_MAX_ATTEMPTS} the firing is given up — a moment is switched off, so it
 * does not hold one of its owner's watcher slots with nothing left to do — and the owner is told.
 */
export const settleEventRun = internalMutation
    .input({ attempt: v.number(), firing: v.number(), sent: v.boolean(), triggerId: v.id("triggers") })
    .output(v.null())
    .mutation(async ({ args: { attempt, firing, sent, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);
        const pending = trigger?.eventState?.pendingRun;

        if (!trigger || pending?.firing !== firing) {
            return null;
        }

        const { now } = ctx;
        const rest = withoutPendingRun(trigger.eventState);

        if (sent) {
            await patchRow(ctx.db, trigger, { eventState: rest });

            return null;
        }

        if (attempt + 1 < EVENT_RUN_MAX_ATTEMPTS) {
            await ctx.scheduler.runAfter(EVENT_RUN_RETRY_MS * 2 ** attempt, internal.triggers.events.startEventRun, {
                attempt: attempt + 1,
                firing,
                payload: pending.payload,
                triggerId,
                userId: trigger.userId,
            });

            return null;
        }

        const error = "A run of this trigger could not be queued and was dropped.";

        await patchRow(ctx.db, trigger, {
            eventState: rest,
            lastError: error,
            updatedAt: now,
            ...(trigger.eventSource?.kind === "time" && { enabled: false }),
        });
        await notifyQuietly(ctx, {
            body: error,
            dedupeKey: `trigger-run-dropped:${trigger._id}:${firing}`,
            link: "/dashboard/settings/chat/triggers",
            outcome: "failure",
            title: trigger.name,
            type: "trigger",
            userId: trigger.userId,
        });

        return null;
    });

/**
 * Stores what a check found. A condition that fired starts one run, once: the occurrence is claimed
 * (`claimOnce` on the trigger and the source's key), so a duplicate tick or a retried check that saw the same
 * thing starts nothing; the run itself is handed to {@link startEventRun} and rides the jobs queue under its own claim.
 * A failed check counts toward pausing the watcher only if its cause is the owner's to fix; an outage backs it off instead.
 */
export const recordEventCheck = internalMutation
    .input({
        error: v.optional(v.string().max(MAX_LENGTH.short)),
        fire: v.optional(
            v.object({
                excerpt: v.optional(v.string().max(MAX_LENGTH.long)),
                key: v.string().max(MAX_LENGTH.key),
                summary: v.string().max(MAX_LENGTH.long),
            }),
        ),
        // What the check read: the arming, the condition and the time of the check before it. An answer is kept only if all still hold.
        read: v.object({ armedAt: v.optional(v.number()), checkedAt: v.optional(v.number()), source: vEventSource }),
        state: v.optional(vEventState),
        // The failure heals on its own (a timeout, an outage): it backs the watcher off and never pauses it.
        transient: v.optional(v.boolean()),
        triggerId: v.id("triggers"),
    })
    .output(v.object({ fired: v.boolean() }))
    .mutation(async ({ args: { error, fire, read, state, transient, triggerId }, ctx }) => {
        const trigger = await ctx.db.get(triggerId);

        // Switched off, edited, deleted or overtaken by another check while this one ran: its answer is about something else now.
        if (
            trigger?.type !== "event" ||
            trigger.enabled !== true ||
            !trigger.eventSource ||
            watchesSomethingElse(trigger.eventSource, read.source) ||
            trigger.eventState?.armedAt !== read.armedAt ||
            trigger.eventState?.checkedAt !== read.checkedAt ||
            // A moment fires once. Its claim lapses after a few minutes and its run can take longer: a check that reaches it then is moot.
            (trigger.eventSource.kind === "time" && trigger.eventState?.firedAt !== undefined)
        ) {
            return { fired: false };
        }

        if (error !== undefined) {
            await failCheck(ctx, trigger, error, transient === true);

            return { fired: false };
        }

        const { now } = ctx;
        const config = trigger.eventSource;
        const interval = Math.max(checkIntervalMs(config), EVENT_CHECK_LEASE_MS);

        const fireKey = fire ? `${trigger._id}:${fire.key}` : undefined;
        const claimed = fireKey !== undefined && (await claimOnce(ctx, EVENT_FIRE_SCOPE, fireKey, EVENT_FIRE_CLAIM_TTL_MS, trigger.userId));
        const { checkFailures, checkRetries } = state ?? trigger.eventState ?? {};
        // The pending run is the watcher's own record, settled by `settleEventRun`: a check that read it earlier must not bring it back.
        const kept = withoutPendingRun(withoutCheckMarks(state ?? trigger.eventState));
        const pendingRun = trigger.eventState?.pendingRun;
        // A moment in time fires once and is done; the others keep watching, after a cooldown.
        const nextTriggerAt = nextCheckAfterSuccess(config, { fired: fire !== undefined, interval, now, started: claimed });
        const recovered = (checkFailures ?? 0) > 0 || (checkRetries ?? 0) > 0;
        const payload = claimed && fire ? buildEventPayload(fire.summary, fire.excerpt) : undefined;
        // An earlier firing the queue has not taken yet keeps its place — it is still being retried — and the newer occurrence
        // is folded into it (counted in `coalesced`); only one presumed dead (past the horizon) is replaced.
        const foldIntoPending = payload !== undefined && pendingRun !== undefined && now - pendingRun.firing < EVENT_PENDING_RUN_HORIZON_MS;
        const nextPendingRun = payload === undefined ? pendingRun : nextPending(pendingRun, foldIntoPending, { firing: now, payload });

        await patchRow(ctx.db, trigger, {
            eventState: {
                ...kept,
                checkedAt: now,
                ...(claimed && { firedAt: now }),
                ...(nextPendingRun && { pendingRun: nextPendingRun }),
            },
            nextTriggerAt,
            updatedAt: now,
            ...(recovered && { lastError: undefined }),
        });

        if (nextTriggerAt !== undefined) {
            await noteShardDue(ctx, nextTriggerAt, trigger.userId);
        }

        if (payload !== undefined && !foldIntoPending) {
            // Scheduled, not sent: a job scheduled by a mutation is dropped with it if it fails, a queue send is not.
            await ctx.scheduler.runAfter(0, internal.triggers.events.startEventRun, {
                firing: now,
                payload,
                triggerId,
                userId: trigger.userId,
            });
        }

        return { fired: claimed };
    });
