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
 *   that occurrence once (`lib/claim-once.ts`) and enqueues the ordinary trigger run (`executeTrigger`) on the jobs queue.
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
import { fetchWatchedPage } from "./event-sources/fetch-page";
import { isOwnerFixableCheckFailure, EventCheckError } from "./event-sources/check-failure";
import { scanThreadRows } from "./event-sources/thread-scan";
import type { ScanRow } from "./event-sources/thread-scan";
import type { EventCheckContext, ThreadScan } from "./event-sources/types";
import { MAX_ACTIVE_EVENT_WATCHERS, MINUTE_MS } from "./event-sources/types";
import type { EventState } from "./validators";
import { vEventSource, vEventState } from "./validators";

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
/** Rows read per scan of a thread. A longer stretch is read over several checks: the baseline moves to the last row read. */
const THREAD_SCAN_ROWS = 60;
/** The longest a transient failure delays the next check. */
const EVENT_MAX_BACKOFF_MS = 6 * 60 * MINUTE_MS;

/** Consecutive failed checks are counted with the same streak rule as failed runs. */
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

    return { eventState: {}, nextTriggerAt: firstCheckAt(config, now) };
};

/** A user keeps at most {@link MAX_ACTIVE_EVENT_WATCHERS} watchers switched on: each is checked every few minutes. */
export const assertWatcherCapacity = async (ctx: Pick<MutationCtx, "db">, userId: string): Promise<void> => {
    const mine = await ctx.db
        .query("triggers")
        .withIndex("by_userId_organizationId", (q) => q.eq("userId", userId))
        .collect();

    if (mine.filter((row) => row.type === "event" && row.enabled === true).length >= MAX_ACTIVE_EVENT_WATCHERS) {
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

/** The baseline without the counters of failed checks. */
const withoutCounters = (state: EventState | undefined): EventState => {
    const kept = { ...state };

    delete kept.checkFailures;
    delete kept.checkRetries;

    return kept;
};

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
        const armed = await ctx.db
            .query("triggers")
            .withIndex("by_enabled_nextTriggerAt", (q) => q.eq("enabled", true).lte("nextTriggerAt", now))
            .collect();
        const due = armed.filter((row) => row.type === "event");
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

            try {
                await ctx.scheduler.runAfter(0, internal.triggers.events.runEventCheck, { triggerId: trigger._id });
            } catch (error) {
                console.error(`[Triggers] Could not schedule the check of trigger ${trigger._id}; it stays due for the next tick`, error);

                continue;
            }

            await ctx.db.patch(trigger._id, { nextTriggerAt: now + EVENT_CHECK_LEASE_MS });
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
    const read = { checkedAt: trigger.eventState?.checkedAt, source: trigger.eventSource! };

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
 * Stores what a check found. A condition that fired starts one run, once: the occurrence is claimed
 * (`claimOnce` on the trigger and the source's key), so a duplicate tick or a retried check that saw the same
 * thing starts nothing; the run itself rides the jobs queue under its own claim (`enqueueJob({ once })`).
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
        // What the check read: the condition and the time of the check before it. An answer is kept only if both still hold.
        read: v.object({ checkedAt: v.optional(v.number()), source: vEventSource }),
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
            trigger.eventState?.checkedAt !== read.checkedAt
        ) {
            return { fired: false };
        }

        const { now } = ctx;
        const config = trigger.eventSource;
        const interval = Math.max(checkIntervalMs(config), EVENT_CHECK_LEASE_MS);

        if (error !== undefined) {
            const retries = transient === true ? (trigger.eventState?.checkRetries ?? 0) + 1 : 0;
            const { pause, streak } = advanceStreak(trigger.eventState?.checkFailures ?? 0, transient === true ? "transient" : "user-fixable");
            // An outage waits twice as long after each check it spoils, up to a cap; a failure the owner must fix keeps the usual pace until the pause.
            const wait = retries > 0 ? Math.min(interval * 2 ** (retries - 1), Math.max(EVENT_MAX_BACKOFF_MS, interval)) : interval;

            const counters = { ...(streak > 0 && { checkFailures: streak }), ...(retries > 0 && { checkRetries: retries }) };

            await patchRow(ctx.db, trigger, {
                eventState: { ...withoutCounters(trigger.eventState), checkedAt: now, ...counters },
                lastError: error,
                nextTriggerAt: pause ? undefined : now + wait,
                updatedAt: now,
                ...(pause && { enabled: false }),
            });

            if (pause) {
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
            } else {
                await noteShardDue(ctx, now + wait, trigger.userId);
            }

            return { fired: false };
        }

        const fireKey = fire ? `${trigger._id}:${fire.key}` : undefined;
        const claimed = fireKey !== undefined && (await claimOnce(ctx, EVENT_FIRE_SCOPE, fireKey, EVENT_FIRE_CLAIM_TTL_MS, trigger.userId));
        const { checkFailures, checkRetries } = state ?? trigger.eventState ?? {};
        const kept = withoutCounters(state ?? trigger.eventState);
        // A moment in time fires once and is done; the others keep watching, after a cooldown.
        const nextTriggerAt = nextCheckAfterSuccess(config, { fired: fire !== undefined, interval, now, started: claimed });
        const recovered = (checkFailures ?? 0) > 0 || (checkRetries ?? 0) > 0;

        await patchRow(ctx.db, trigger, {
            eventState: { ...kept, checkedAt: now, ...(claimed && { firedAt: now }) },
            nextTriggerAt,
            updatedAt: now,
            ...(recovered && { lastError: undefined }),
        });

        if (nextTriggerAt !== undefined) {
            await noteShardDue(ctx, nextTriggerAt, trigger.userId);
        }

        if (claimed && fire) {
            // Last: a send that fails rolls the claim and the baseline back, and the lease retries the check.
            await enqueueJob(
                internal.triggers.execute.executeTrigger,
                { payload: buildEventPayload(fire.summary, fire.excerpt), triggerId },
                { once: { userId: trigger.userId }, shardKey: trigger.userId },
            );
        }

        return { fired: claimed };
    });
