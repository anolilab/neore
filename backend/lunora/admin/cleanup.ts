/**
 * Admin Cleanup Functions
 *
 * Backend functions for the admin cleanup dashboard.
 * Allows admins to preview and execute bulk removal of inactive anonymous users.
 *
 * All public functions require admin role.
 */
import { env } from "cloudflare:workers";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { adminAction, adminMutation, adminQuery, rateLimit } from "../lib/crpc";
import { withoutUndefined } from "../lib/patch";
import { callOnShard } from "../lib/cross-shard";
import { decryptKey, encryptKey } from "../lib/encryption";
import { ROOT_SHARD_KEY } from "../lib/shard-context";
import { isShardRoutingEnabled } from "../lib/shard-namespace";
import { MAX_LENGTH } from "../lib/validators";
import {
    addMessageRow,
    addThreadRow,
    approxRowBytes,
    type BreakdownEntry,
    type CensusCursor,
    classifyThread,
    FOOTPRINT_PAGE_SIZE,
    finishCurrentThread,
    forCursor,
    keepTop,
    knownClassFor,
    largestRowsOf,
    LARGEST_SHARD_COUNT,
    LARGEST_THREAD_COUNT,
    mergeBreakdowns,
    withRootShard,
    type FootprintState,
    MAX_SHARD_CALLS_PER_ACTION,
    type PendingShard,
    rootOnlyCensus,
    type ScanEntry,
    type ThreadClass,
    SHARDS_PER_CALL,
    startCensus,
    startFootprint,
    runScanRounds,
    willRetry,
} from "./shard-footprint-logic";

const DEFAULT_THRESHOLD_DAYS = 30;
const DEFAULT_BATCH_SIZE = 100;

// =============================================================================
// Config
// =============================================================================

/**
 * Get current cleanup configuration.
 * Returns defaults if no config document exists yet.
 */
export const getCleanupConfig = adminQuery
    .output(v.object({ batchSize: v.number(), isEnabled: v.boolean(), thresholdDays: v.number() }))
    .query(async ({ ctx }) => {
        const config = await ctx.db.cleanupConfigs.findFirst({});

        return {
            batchSize: config?.batchSize ?? DEFAULT_BATCH_SIZE,
            isEnabled: config?.isEnabled ?? false,
            thresholdDays: config?.thresholdDays ?? DEFAULT_THRESHOLD_DAYS,
        };
    });

/**
 * Update cleanup configuration.
 * Creates a config document if none exists.
 */
export const updateCleanupConfig = adminMutation
    .use(rateLimit("admin/write"))
    .input({
        batchSize: v.optional(v.number()),
        isEnabled: v.optional(v.boolean()),
        thresholdDays: v.optional(v.number()),
    })
    .mutation(async ({ args: input, ctx }) => {
        const existing = await ctx.db.cleanupConfigs.findFirst({});

        if (existing) {
            const patch: Partial<Doc<"cleanupConfigs">> = {};

            if (input.thresholdDays !== undefined) {
                patch["thresholdDays"] = input.thresholdDays;
            }

            if (input.batchSize !== undefined) {
                patch["batchSize"] = input.batchSize;
            }

            if (input.isEnabled !== undefined) {
                patch["isEnabled"] = input.isEnabled;
            }

            await ctx.db.patch("cleanupConfigs", existing._id, withoutUndefined(patch));
        } else {
            await ctx.db.insert("cleanupConfigs", {
                batchSize: input.batchSize ?? DEFAULT_BATCH_SIZE,
                isEnabled: input.isEnabled ?? false,
                thresholdDays: input.thresholdDays ?? DEFAULT_THRESHOLD_DAYS,
            });
        }

        ctx.log.event("admin.update_cleanup_config", { created: !existing, isEnabled: input.isEnabled });

        return null;
    });

// =============================================================================
// Preview
// =============================================================================

/**
 * Preview how many anonymous users are eligible for cleanup.
 * Does not delete anything.
 */
export const previewCleanup = adminQuery
    .input({ now: v.number() })
    .output(v.object({ eligibleCount: v.number(), thresholdDays: v.number() }))
    .query(async ({ args, ctx }) => {
        const config = await ctx.db.cleanupConfigs.findFirst({});
        const thresholdDays = config?.thresholdDays ?? DEFAULT_THRESHOLD_DAYS;
        const cutoff = args.now - thresholdDays * 24 * 60 * 60 * 1000;

        // A count, not a page: the preview only reports how many rows the cleanup
        // would touch, and a capped read would report the cap instead of the truth.
        const eligibleCount = await ctx.db.user.count({ isAnonymous: true, updatedAt: { lt: cutoff } });

        return { eligibleCount, thresholdDays };
    });

// =============================================================================
// Execute
// =============================================================================

/**
 * Execute cleanup of inactive anonymous users.
 * Processes up to `batchSize` users per run.
 * In dry-run mode returns counts without deleting.
 */
export const executeCleanup = adminAction
    .use(rateLimit("admin/cleanup"))
    .input({
        // Native validator rather than `v.from(z.boolean().default(false))`:
        // codegen reads `v.*` directly, and an absent boolean is already falsy at
        // both use sites below, so the zod default was doing nothing the optional
        // does not.
        dryRun: v.optional(v.boolean()),
    })
    .output(v.object({ deletedCount: v.number(), durationMs: v.number(), eligibleCount: v.number() }))
    .action(async ({ args: input, ctx }) => {
        const start = Date.now();

        const config = await ctx.runQuery(internal.admin.cleanup.getCleanupConfigInternal, {});
        const eligibleUsers = await ctx.runQuery(internal.admin.cleanup.getEligibleUsers, {
            limit: config.batchSize,
            now: start,
            thresholdMs: config.thresholdDays * 24 * 60 * 60 * 1000,
        });

        const eligibleCount = eligibleUsers.length;
        let deletedCount = 0;

        if (!input.dryRun) {
            const results = await Promise.allSettled(
                eligibleUsers.map(async (user) => {
                    const userId = user._id as string;

                    // The user's threads and settings live on THEIR shard, not the
                    // admin's this action runs on.
                    const onUserShard = { shardKey: userId };
                    const threads = await callOnShard(internal.admin.cleanup.getUserThreads, { userId }, onUserShard);

                    await Promise.allSettled(
                        threads.map(
                            async (thread: { _id: string }) =>
                                await callOnShard(internal.agent.threads.deleteAllForThreadIdAsync, { threadId: thread._id as Id<"threads"> }, onUserShard),
                        ),
                    );

                    // `auth_hooks.cascadeDeleteUser` already deletes the session and
                    // account rows, by index, along with the other four user-owned tables — so
                    // this is the same work through the one function that owns it.
                    await callOnShard(internal.auth.hooks.cascadeDeleteUser, { userId: userId as Id<"user"> }, onUserShard);

                    // Delete the user record itself
                    await ctx.runMutation(internal.auth.hooks.deleteUserRecord, { userDocId: user._id });
                }),
            );

            for (const result of results) {
                if (result.status === "fulfilled") {
                    deletedCount += 1;
                } else {
                    console.error("Cleanup: failed to delete user:", result.reason);
                }
            }
        }

        const durationMs = Date.now() - start;

        await ctx.runMutation(internal.admin.cleanup.writeCleanupLog, {
            deletedCount,
            durationMs,
            eligibleCount,
            mode: input.dryRun ? "dry_run" : "execute",
            runAt: Date.now(),
            triggeredBy: ctx.user.userId,
        });

        ctx.log.event("admin.execute_cleanup", {
            deletedCount,
            dryRun: input.dryRun === true,
            durationMs,
            eligibleCount,
        });

        return { deletedCount, durationMs, eligibleCount };
    });

// =============================================================================
// Logs
// =============================================================================

/**
 * List cleanup run history, newest first.
 */
export const listCleanupLogs = adminQuery
    .input({
        cursor: v.optional(v.union(v.string().max(MAX_LENGTH.cursor), v.null())),
        // The bound is applied in the handler, and stays there. Codegen sees
        // through `v.from` since cli@176, so the original reason is gone —
        // but moving the bound to the boundary would change behaviour, not just
        // location: the handler CLAMPS with `Math.min(100, Math.max(1, …))`,
        // whereas a boundary check REJECTS. `limit: 500` would go from returning
        // 100 rows to a validation error for every existing caller.
        limit: v.optional(v.number()),
    })
    .output(
        v.object({
            continueCursor: v.optional(v.union(v.string(), v.null())),
            isDone: v.boolean(),
            logs: v.array(
                v.object({
                    _creationTime: v.number(),
                    _id: v.string(),
                    deletedCount: v.number(),
                    durationMs: v.number(),
                    eligibleCount: v.number(),
                    mode: v.union(v.literal("dry_run"), v.literal("execute")),
                    runAt: v.number(),
                    triggeredBy: v.string(),
                }),
            ),
        }),
    )
    .query(async ({ args: input, ctx }) => {
        const result = await ctx.db.cleanupLogs.findMany({
            cursor: input.cursor ?? null,
            limit: Math.min(100, Math.max(1, input.limit ?? 20)),
            orderBy: [{ runAt: "desc" }],
        });

        return {
            continueCursor: result.continueCursor,
            isDone: result.isDone,
            logs: result.page.map((log) => {
                return {
                    ...log,
                    _id: log._id as string,
                    mode: log.mode as "dry_run" | "execute",
                };
            }),
        };
    });

// =============================================================================
// Internal helpers (called from executeCleanup action)
// =============================================================================

export const getCleanupConfigInternal = internalQuery
    .input({})
    .output(
        v.object({
            batchSize: v.number(),
            isEnabled: v.boolean(),
            thresholdDays: v.number(),
        }),
    )
    .query(async ({ ctx }) => {
        const config = await ctx.db.cleanupConfigs.findFirst({});

        return {
            batchSize: config?.batchSize ?? DEFAULT_BATCH_SIZE,
            isEnabled: config?.isEnabled ?? false,
            thresholdDays: config?.thresholdDays ?? DEFAULT_THRESHOLD_DAYS,
        };
    });

/** `now` comes from the action that calls this; a query must not read the clock. */
export const getEligibleUsers = internalQuery
    .input({ limit: v.number(), now: v.number(), thresholdMs: v.number() })
    .query(async ({ args: { limit, now, thresholdMs }, ctx }) => {
        const cutoff = now - thresholdMs;

        return await ctx.db.user.findMany({ limit, where: { isAnonymous: true, updatedAt: { lt: cutoff } } }).then((result) => result.page);
    });

export const getUserThreads = internalQuery.input({ userId: v.string() }).query(async ({ args: { userId }, ctx }) =>
    ctx.db
        .query("threads")
        .withIndex("by_user_and_status", (q) => q.eq("userId", userId))
        .collect(),
);

export const writeCleanupLog = internalMutation
    .input({
        deletedCount: v.number(),
        durationMs: v.number(),
        eligibleCount: v.number(),
        mode: v.union(v.literal("dry_run"), v.literal("execute")),
        runAt: v.number(),
        triggeredBy: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.insert("cleanupLogs", args);

        return null;
    });

// =============================================================================
// Shard footprint
// =============================================================================
// Measures how much conversation data each user shard stores. `measureShardPage` runs on the
// shard it measures and reads one page per call (threads, then message rows); a caller continues
// until `done`. `getShardFootprint` drives a page of the shard census and returns totals only: no
// thread ids or shard keys are in its fields. Its cursor holds shard keys and the scan's index positions,
// which name threads, so it is sealed before it reaches the browser. Counts are approximate under concurrent writes.
// Beside the totals it reports counts by thread group and age band (the readings the retention
// plan's decisions need) and the sizes of the largest threads and shards, as bare numbers.

/** A breakdown entry's fields, spread into each validator that carries one. */
const breakdownEntryFields = {
    approxBytes: v.number(),
    group: v.union(v.literal("active"), v.literal("archived"), v.literal("other"), v.literal("pinned")),
    largeToolBytes: v.number(),
    largeToolRows: v.number(),
    messageRows: v.number(),
    sinceDays: v.number(),
    threads: v.number(),
    toolBytes: v.number(),
};

/** The scan state's fields, spread into each validator that carries it. */
const footprintFields = {
    approxBytes: v.number(),
    breakdown: v.array(v.object({ ...breakdownEntryFields })),
    carriedLargestRows: v.array(v.number()),
    currentClass: v.union(
        v.object({ group: v.union(v.literal("active"), v.literal("archived"), v.literal("other"), v.literal("pinned")), sinceDays: v.number() }),
        v.null(),
    ),
    currentRows: v.number(),
    currentThreadId: v.union(v.string(), v.null()),
    cursor: v.union(v.string(), v.null()),
    largest: v.array(v.object({ rows: v.number(), threadId: v.string() })),
    messageRows: v.number(),
    phase: v.union(v.literal("threads"), v.literal("messages"), v.literal("done")),
    threads: v.number(),
};

/**
 * One page of a shard's measurement. Message rows are read through their thread index, so a thread's rows arrive together,
 * and each thread a page starts is read once, all of them side by side, so a page reads its rows plus at most one thread
 * per row. `now` places each thread in its age band; the admin call passes the census's clock.
 */
export const measureShardPage = internalQuery
    .input({ now: v.number(), state: v.optional(v.object({ ...footprintFields })) })
    .output(v.object({ done: v.boolean(), pageRows: v.number(), state: v.object({ ...footprintFields }) }))
    .query(async ({ args, ctx }) => {
        const state: FootprintState = args.state ?? startFootprint();

        if (state.phase === "done") {
            return { done: true, pageRows: 0, state };
        }

        if (state.phase === "threads") {
            const page = await ctx.db.query("threads").paginate({ cursor: state.cursor, numItems: FOOTPRINT_PAGE_SIZE });
            let next = state;

            for (const thread of page.page) {
                next = addThreadRow(next, classifyThread(thread, args.now), approxRowBytes(thread));
            }

            return {
                done: false,
                pageRows: page.page.length,
                state: { ...next, cursor: page.isDone ? null : page.continueCursor, phase: page.isDone ? "messages" : "threads" },
            };
        }

        const page = await ctx.db.query("messages").withIndex("by_threadId_order_stepOrder").paginate({ cursor: state.cursor, numItems: FOOTPRINT_PAGE_SIZE });

        const startedThreads = [...new Set(page.page.map((row) => row.threadId))].filter((threadId) => knownClassFor(state, String(threadId)) === undefined);
        const startedClasses = new Map(
            await Promise.all(
                startedThreads.map(async (threadId): Promise<[string, ThreadClass]> => [
                    String(threadId),
                    classifyThread(await ctx.db.get("threads", threadId), args.now),
                ]),
            ),
        );
        let next = state;

        for (const row of page.page) {
            const threadId = String(row.threadId);
            // Rows are grouped by thread, so a row either continues the current thread or starts one read above.
            const threadClass = knownClassFor(next, threadId) ?? (startedClasses.get(threadId) as ThreadClass);
            const toolOutput = (row.message as { role?: unknown } | undefined)?.role === "tool";

            next = addMessageRow(next, { bytes: approxRowBytes(row), threadClass, threadId, toolOutput });
        }

        if (page.isDone) {
            return { done: true, pageRows: page.page.length, state: { ...finishCurrentThread(next), cursor: null, phase: "done" } };
        }

        return { done: false, pageRows: page.page.length, state: { ...next, cursor: page.continueCursor } };
    });

/**
 * One page of the census: the users, in `_id` order. A user's shard is keyed by its id. Users are the
 * census, not `shardActivity`, because the activity rows are a best-effort hint and can be missing.
 */
export const listShardKeysPage = internalQuery
    .input({ cursor: v.optional(v.string()), limit: v.number() })
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), isDone: v.boolean(), shardKeys: v.array(v.string()) }))
    .query(async ({ args, ctx }) => {
        const page = await ctx.db.user.findMany({
            cursor: args.cursor ?? null,
            limit: args.limit,
            orderBy: [{ _id: "asc" }],
        });

        return {
            continueCursor: page.continueCursor,
            isDone: page.isDone,
            shardKeys: page.page.map((user) => String(user._id)).filter((shardKey) => shardKey !== ROOT_SHARD_KEY),
        };
    });

/** The census cursor an admin call carries: the census position and the shards still being measured. */
const censusCursorValidator = v.object({
    census: v.union(v.string(), v.null()),
    censusDone: v.boolean(),
    pending: v.array(v.object({ failures: v.optional(v.number()), shardKey: v.string(), state: v.object({ ...footprintFields }) })),
    startedAt: v.number(),
});

/**
 * The opaque string an admin call returns and takes back, sealed (AES-GCM, its own key purpose): the shard keys and
 * index positions in it name users and threads, and the browser that holds it can neither read nor alter it.
 */
export const encodeCensusCursor = async (cursor: CensusCursor): Promise<string> => {
    const forBrowser = {
        ...cursor,
        pending: cursor.pending.map((entry) => {
            return { ...entry, state: forCursor(entry.state) };
        }),
    };

    return await encryptKey(JSON.stringify(forBrowser), "census-cursor");
};

/** The census cursor a sealed string holds, or `undefined` when the string is not one this module sealed. */
export const decodeCensusCursor = async (encoded: string): Promise<CensusCursor | undefined> => {
    // Only the current format: an unversioned string would be opened with the legacy master key.
    if (!encoded.startsWith("v1:")) {
        return undefined;
    }

    let json: unknown;

    try {
        json = JSON.parse(await decryptKey(encoded, "census-cursor"));
    } catch {
        return undefined;
    }

    const parsed = censusCursorValidator.safeParse(json);

    return parsed.ok ? parsed.value : undefined;
};

/** The census cursor after `page` of the census: the page's shards join the ones still pending. */
const addCensusPage = (carried: CensusCursor, page: { continueCursor: string | null; isDone: boolean; shardKeys: string[] }): CensusCursor => {
    return {
        ...carried,
        census: page.isDone ? null : page.continueCursor,
        censusDone: page.isDone,
        pending: [
            ...carried.pending,
            ...page.shardKeys.map((shardKey): PendingShard => {
                return { shardKey, state: startFootprint() };
            }),
        ],
    };
};

/** Reads one page of a shard at `now`. A failure is thrown, so the scan can count the shard as incomplete. */
const readShardPage =
    (now: number) =>
    async (entry: ScanEntry): Promise<{ done: boolean; state: FootprintState }> => {
        const result = await callOnShard(internal.admin.cleanup.measureShardPage, { now, state: entry.state }, { shardKey: entry.shardKey });

        return { done: result.done, state: result.state };
    };

/**
 * Totals for the shards this call finished. A shard that is not finished yet is `pendingShards`: its
 * state travels in `continueCursor`, and its counts join the totals once a later call finishes it, so
 * no shard is counted twice. A shard that errors is `incompleteShards`, its counts are left out, and it
 * stays pending so a later call retries it. Continue with `continueCursor` until it is `null`.
 *
 * `breakdown`, `largestThreadRows` and `largestShardBytes` cover the same finished shards, so a caller merges pages
 * the same way: sum the breakdown by group and age band, and keep the largest numbers of the two lists.
 */
export const getShardFootprint = adminAction
    .use(rateLimit("admin/read"))
    .input({ cursor: v.optional(v.string()) })
    .output(
        v.object({
            abandonedShards: v.number(),
            approxBytes: v.number(),
            breakdown: v.array(v.object({ ...breakdownEntryFields })),
            continueCursor: v.union(v.string(), v.null()),
            incompleteShards: v.number(),
            isDone: v.boolean(),
            /** The sizes of the largest finished shards, largest first. No shard key. */
            largestShardBytes: v.array(v.number()),
            /** The row counts of the largest finished threads, largest first. No thread id. */
            largestThreadRows: v.array(v.number()),
            messageRows: v.number(),
            pendingShards: v.number(),
            shards: v.number(),
            threads: v.number(),
        }),
    )
    .action(async ({ args, ctx }) => {
        const carried: CensusCursor | undefined = args.cursor === undefined ? startCensus(Date.now()) : await decodeCensusCursor(args.cursor);

        if (carried === undefined) {
            throw new LunoraError("INVALID_INPUT", "The footprint cursor is not valid. Start the measurement again without a cursor.");
        }

        // With routing collapsed (development) every census key reaches the root shard, so the root is measured once.
        let cursor = carried;

        if (!isShardRoutingEnabled(env)) {
            cursor = rootOnlyCensus(carried, ROOT_SHARD_KEY);
        } else if (!carried.censusDone) {
            // The root shard holds anonymous conversations that no user row owns, so the first call measures it too.
            const seeded = withRootShard(carried, ROOT_SHARD_KEY);

            cursor = seeded;

            if (seeded.pending.length < SHARDS_PER_CALL) {
                const page = await ctx.runQuery(internal.admin.cleanup.listShardKeysPage, {
                    cursor: seeded.census ?? undefined,
                    limit: SHARDS_PER_CALL - seeded.pending.length,
                });

                cursor = addCensusPage(seeded, page);
            }
        }

        const entries: ScanEntry[] = cursor.pending.map(({ shardKey, state }) => {
            return { shardKey, state, status: "active" };
        });

        await runScanRounds(entries, readShardPage(cursor.startedAt), MAX_SHARD_CALLS_PER_ACTION);

        const totals = {
            abandonedShards: 0,
            approxBytes: 0,
            breakdown: [] as BreakdownEntry[],
            continueCursor: null as string | null,
            incompleteShards: 0,
            isDone: false,
            largestShardBytes: [] as number[],
            largestThreadRows: [] as number[],
            messageRows: 0,
            pendingShards: 0,
            shards: 0,
            threads: 0,
        };
        const stillPending: PendingShard[] = [];
        const failureNames: string[] = [];
        const failuresBefore = new Map<string, number>(cursor.pending.map((entry): [string, number] => [entry.shardKey, entry.failures ?? 0]));

        for (const entry of entries) {
            if (entry.status === "done") {
                totals.shards += 1;
                totals.approxBytes += entry.state.approxBytes;
                totals.messageRows += entry.state.messageRows;
                totals.threads += entry.state.threads;
                totals.breakdown = mergeBreakdowns(totals.breakdown, entry.state.breakdown);
                totals.largestShardBytes = keepTop([...totals.largestShardBytes, entry.state.approxBytes], LARGEST_SHARD_COUNT);
                totals.largestThreadRows = keepTop([...totals.largestThreadRows, ...largestRowsOf(entry.state)], LARGEST_THREAD_COUNT);
            } else if (entry.status === "failed") {
                // A page that read earlier in this call resets the count, so only the failures since then count.
                const failures = (entry.succeeded ? 0 : (failuresBefore.get(entry.shardKey) ?? 0)) + 1;

                failureNames.push(entry.errorName ?? "unknown");

                if (willRetry(failures)) {
                    // Keeps its last good state and its failure count, so a later call retries it from there.
                    totals.incompleteShards += 1;
                    stillPending.push({ failures, shardKey: entry.shardKey, state: entry.state });
                } else {
                    // Given up for this census: its counts stay out of the totals, and the census can finish without it.
                    totals.abandonedShards += 1;
                }
            } else {
                // A page that read successfully resets the failure count.
                stillPending.push({ shardKey: entry.shardKey, state: entry.state });
            }
        }

        totals.pendingShards = stillPending.length;
        totals.isDone = cursor.censusDone && stillPending.length === 0;
        totals.continueCursor = totals.isDone ? null : await encodeCensusCursor({ ...cursor, pending: stillPending });

        ctx.log.event("admin.shard_footprint_measured", {
            abandonedShards: totals.abandonedShards,
            failedBy: failureNames.toSorted((a, b) => a.localeCompare(b)).join(","),
            incompleteShards: totals.incompleteShards,
            isDone: totals.isDone,
            pendingShards: totals.pendingShards,
            shards: totals.shards,
        });

        return totals;
    });
