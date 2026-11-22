/**
 * Nightly memory reflection — scheduling, I/O and the bounded LLM calls.
 * The decisions themselves are pure and tested in `reflection-logic.ts`.
 *
 * ## Scheduling without a cron
 *
 * No cron walks the user table. Activity schedules the work instead: after an
 * interactive reply for a user with memory on, `afterRun` schedules
 * {@link noteMemoryActivity}, which stamps `lastActiveAt` and — when no run is
 * pending — schedules {@link runMemoryReflection} with `ctx.scheduler.runAt` at
 * the next 03:xx in the user's timezone. So only users active in the last day
 * ever have a run queued, and a user who stops chatting stops costing anything
 * after one more night.
 *
 * The run re-checks everything when it fires ({@link claimReflectionRun}):
 * memory still on (OPT-IN — `isMemoryEnabled`'s rule), active within 24h, inside
 * the local night window, and not already run for this local day. A duplicated
 * or stale job therefore does nothing; one that lands outside the window books
 * the next night's run.
 *
 * ## Cost
 *
 * One synthesis call (merge wording, promotion decisions, digest) plus at most
 * `maxBeliefRevisions` belief-revision calls, all through `getUtilityModel`, all
 * reserved against one token/call budget (`createReflectionBudget`). A call the
 * budget refuses is skipped and the deterministic part of the plan (decay,
 * merges with the survivor's own wording) still applies.
 */
import { generateText, Output } from "ai";
import { v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { gatewayFetch } from "../lib/services";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { getUtilityModel } from "../lib/utility-model";
import { runBeliefRevision } from "./extract";
import { reembedRewordedMemory } from "./functions";
import {
    buildReflectionPrompt,
    checkReflectionEligibility,
    createReflectionBudget,
    decayToOps,
    digestDayOf,
    expiryToOps,
    estimateTokens,
    localDayOf,
    mergeToOps,
    nextReflectionRunAt,
    planActivityUpdate,
    planReflection,
    promotionToOp,
    REFLECTION_LIMITS,
    REFLECTION_SYSTEM_PROMPT,
    type ContradictionCandidate,
    type ReflectionMemory,
    type ReflectionOp,
    revisionToOps,
    committedReflectionOps,
    countAppliedMerges,
    countResolvedContradictions,
    selectReflectionInputs,
    splitExpired,
} from "./reflection-logic";
import { newestEvidence } from "./evidence";
import { logRedaction, redactDigestSummary, redactMemoryText, redactReflectionOps } from "./redact";
import { factDatesOf, hasFactDates, isExpired, normalizeFactDates, sameFactDates } from "./dates";
import { lastConfirmedOf } from "./taxonomy";
import { MAX_LENGTH } from "../lib/validators";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Memories read per run before `selectReflectionInputs` narrows them to `maxMemories`. */
const REFLECTION_READ_CAP = 1000;

/** Digests kept per user; older ones are pruned when a new one lands. */
const DIGESTS_KEPT = 30;

/** Structured event per run, so skip reasons and spend are countable. */
const REFLECTION_EVENT = "memory.reflection";

const vReflectionMemoryType = v.union(v.literal("identity"), v.literal("preference"), v.literal("context"), v.literal("activity"), v.literal("experience"));

const vDigestView = v.object({
    _id: v.string(),
    createdAt: v.number(),
    learned: v.array(v.object({ memory: v.string(), memoryId: v.string(), type: v.string() })),
    localDay: v.string(),
    stats: v.object({
        contradictionsResolved: v.number(),
        decayed: v.number(),
        merged: v.number(),
        newMemories: v.number(),
        promoted: v.number(),
        retired: v.number(),
    }),
    summary: v.string(),
});

const loadUserSettings = async (ctx: Pick<MutationCtx, "db">, userId: string) =>
    ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .unique();

const loadState = async (ctx: Pick<MutationCtx, "db">, userId: string) =>
    ctx.db
        .query("memoryReflectionState")
        .withIndex("by_userId", (q) => q.eq("userId", userId))
        .first();

// ============================================================================
// Scheduling
// ============================================================================

/**
 * Records that an opted-in user was active, and makes sure tonight's run is
 * scheduled. Cheap when nothing changed: one read of each row, no write.
 */
export const noteMemoryActivity = internalMutation
    .input({ userId: v.string() })
    .output(v.null())
    .mutation(async ({ args: { userId }, ctx }) => {
        const settings = await loadUserSettings(ctx, userId);

        // OPT-IN: absent is off (see `isMemoryEnabled`).
        if (!(settings?.memoryEnabled ?? false)) {
            return null;
        }

        const { now } = ctx;
        const state = await loadState(ctx, userId);
        const plan = planActivityUpdate(state ?? undefined, now);

        if (!plan.recordActivity && !plan.schedule) {
            return null;
        }

        let scheduled: { scheduledFor: number; scheduledJobId: string } | undefined;

        if (plan.schedule) {
            const scheduledFor = nextReflectionRunAt(now, settings?.timezone, userId);
            const scheduledJobId = await ctx.scheduler.runAt(scheduledFor, internal.memory.reflection.runMemoryReflection, { userId });

            scheduled = { scheduledFor, scheduledJobId };
        }

        if (state) {
            await ctx.db.patch("memoryReflectionState", state._id, { lastActiveAt: now, ...scheduled });
        } else {
            await ctx.db.insert("memoryReflectionState", { lastActiveAt: now, userId, ...scheduled });
        }

        return null;
    });

/**
 * Decides, when the job fires, whether this run happens — and if so claims the
 * local day so a duplicate cannot run too. The pending-job fields are cleared
 * so the next activity schedules the next night — except for `outside_window`,
 * which books the next night's run itself.
 */
export const claimReflectionRun = internalMutation
    .input({ userId: v.string() })
    .output(
        v.union(
            v.object({ claimed: v.literal(true), localDay: v.string(), timeZone: v.optional(v.string()) }),
            v.object({ claimed: v.literal(false), reason: v.string() }),
        ),
    )
    .mutation(async ({ args: { userId }, ctx }) => {
        const [settings, state] = await Promise.all([loadUserSettings(ctx, userId), loadState(ctx, userId)]);
        const { now } = ctx;
        const timeZone = settings?.timezone ?? undefined;
        const eligibility = checkReflectionEligibility({
            lastActiveAt: state?.lastActiveAt,
            lastRunLocalDay: state?.lastRunLocalDay ?? undefined,
            memoryEnabled: settings?.memoryEnabled ?? false,
            now,
            timeZone,
        });

        if (!state) {
            return { claimed: false as const, reason: eligibility.eligible ? "no_state" : eligibility.reason };
        }

        // `undefined` REMOVES the pending-job fields (`lib/patch.ts`) — unless they
        // name a LATER job, which activity scheduled while this one was overdue.
        const hasLaterJob = state.scheduledFor !== undefined && state.scheduledFor > now;
        const clearPending = hasLaterJob ? {} : { scheduledFor: undefined, scheduledJobId: undefined };

        if (!eligibility.eligible) {
            // A run that landed outside its window (late alarm, time-zone change,
            // DST) books the next night instead of going quiet until the user chats
            // again. `outside_window` is only reached with memory on and recent
            // activity. `nextReflectionRunAt` is strictly later than `now`, so this
            // cannot loop.
            if (eligibility.reason === "outside_window" && !hasLaterJob) {
                const scheduledFor = nextReflectionRunAt(now, timeZone, userId);
                const scheduledJobId = await ctx.scheduler.runAt(scheduledFor, internal.memory.reflection.runMemoryReflection, { userId });

                await patchRow(ctx.db, "memoryReflectionState", state, { scheduledFor, scheduledJobId });
            } else {
                await patchRow(ctx.db, "memoryReflectionState", state, clearPending);
            }

            return { claimed: false as const, reason: eligibility.reason };
        }

        await patchRow(ctx.db, "memoryReflectionState", state, { ...clearPending, lastRunAt: now, lastRunLocalDay: eligibility.localDay });

        return { claimed: true as const, localDay: eligibility.localDay, ...(timeZone && { timeZone }) };
    });

// ============================================================================
// Inputs and writes
// ============================================================================

const vReflectionRow = v.object({
    confidence: v.number(),
    createdAt: v.number(),
    eventEnd: v.optional(v.string()),
    eventStart: v.optional(v.string()),
    id: v.string(),
    importance: v.number(),
    lastConfirmedAt: v.number(),
    pinned: v.boolean(),
    text: v.string(),
    threadId: v.optional(v.string()),
    type: vReflectionMemoryType,
    updatedAt: v.number(),
    validUntil: v.optional(v.string()),
});

/**
 * Expiry reads a scope's active rows in pages of `EXPIRY_PAGE_ROWS`, each its own query (one transaction stays far below
 * the read limit), at most `EXPIRY_READ_PAGES` of them.
 */
const EXPIRY_PAGE_ROWS = 250;
const EXPIRY_READ_PAGES = 40;
/** Expiry retirements per write, so a scope with many expired rows never needs one oversized transaction. */
const EXPIRY_WRITE_BATCH = 250;
/** How long a failed expiry batch waits before it is written again. */
const EXPIRY_RETRY_DELAY_MS = 5 * 60_000;

const toReflectionRow = (m: Doc<"memories">) => {
    return {
        confidence: m.confidence ?? 70,
        createdAt: m._creationTime,
        id: m._id as string,
        importance: m.importance ?? 50,
        lastConfirmedAt: lastConfirmedOf(m),
        pinned: m.pinned === true,
        text: m.memory,
        type: m.type,
        updatedAt: m.updatedAt ?? m._creationTime,
        ...(m.threadId && { threadId: m.threadId as string }),
        ...factDatesOf(m),
    };
};

export const loadReflectionInputs = internalQuery
    .input({ botId: v.optional(v.string()), now: v.number(), userId: v.string() })
    .output(
        v.object({
            memories: v.array(vReflectionRow),
            threadTitles: v.array(v.string()),
        }),
    )
    .query(async ({ args: { botId, now, userId }, ctx }) => {
        // One scope per call: the user's own memories (no bot), or one bot's. Merging, decay and
        // promotion never cross a scope, so one bot's memory never merges into another's or the user's.
        const scopeBot = (botId ?? null) as Id<"bots"> | null;
        const rows = await ctx.db
            .query("memories")
            .withIndex("by_userId_botId", (q) => q.eq("userId", userId).eq("botId", scopeBot))
            .take(REFLECTION_READ_CAP);
        const memories = rows.filter((m) => !m.supersededBy).map((m) => toReflectionRow(m));

        // "The day's threads": the ones that produced a memory in the last day.
        const since = now - DAY_MS;
        const threadIds = [...new Set(memories.filter((m) => m.createdAt >= since && m.threadId).map((m) => m.threadId!))].slice(
            0,
            REFLECTION_LIMITS.maxThreads,
        );
        const threads = await Promise.all(threadIds.map((id) => ctx.db.get("threads", id as Id<"threads">)));
        // Titles only feed the user's digest, so a bot scope reads none.
        const threadTitles =
            botId === undefined
                ? threads
                      .filter((t): t is Doc<"threads"> => t !== null && t.userId === userId && t.isTemporary !== true && t.deleted !== true && !!t.title)
                      .map((t) => t.title!)
                : [];

        return { memories, threadTitles };
    });

/** One page of a scope's active rows, keeping those past their end date (unpinned): expiry reads the whole scope, page by page. */
export const loadExpiredMemoriesPage = internalQuery
    .input({ botId: v.optional(v.string()), cursor: v.union(v.string(), v.null()), now: v.number(), timeZone: v.optional(v.string()), userId: v.string() })
    .output(v.object({ continueCursor: v.union(v.string(), v.null()), expired: v.array(vReflectionRow), isDone: v.boolean() }))
    .query(async ({ args: { botId, cursor, now, timeZone, userId }, ctx }) => {
        const today = localDayOf(now, timeZone);
        const result = await ctx.db
            .query("memories")
            .withIndex("by_userId_botId_active", (q) =>
                q
                    .eq("userId", userId)
                    .eq("botId", (botId ?? null) as Id<"bots"> | null)
                    .eq("supersededBy", null),
            )
            .order("desc")
            .paginate({ cursor, numItems: EXPIRY_PAGE_ROWS });

        return {
            continueCursor: result.continueCursor,
            expired: result.page.filter((m) => m.pinned !== true && isExpired(m, today)).map((m) => toReflectionRow(m)),
            isDone: result.isDone,
        };
    });

const vReflectionOp = v.union(
    v.object({
        absorbedText: v.optional(v.string()),
        byMemoryId: v.string(),
        checkDates: v.optional(
            v.object({
                by: v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) }),
                memory: v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) }),
            }),
        ),
        expiredOn: v.optional(v.string()),
        kind: v.literal("supersede"),
        memoryId: v.string(),
        merge: v.optional(v.literal(true)),
    }),
    v.object({
        checkDates: v.optional(
            v.object({ memory: v.object({ eventEnd: v.optional(v.string()), eventStart: v.optional(v.string()), validUntil: v.optional(v.string()) }) }),
        ),
        confidence: v.optional(v.number()),
        kind: v.literal("patch"),
        lastConfirmedAt: v.optional(v.number()),
        memory: v.optional(v.string()),
        memoryId: v.string(),
        readText: v.optional(v.string()),
    }),
    v.object({
        confidence: v.number(),
        importance: v.number(),
        kind: v.literal("promote"),
        memory: v.string(),
        sourceIds: v.array(v.string()),
        sourceTexts: v.optional(v.array(v.object({ id: v.string(), memory: v.string() }))),
        threadId: v.optional(v.string()),
        type: vReflectionMemoryType,
    }),
);

/**
 * Applies a run's writes. Every op re-reads its rows and re-checks ownership,
 * that the row is still active, and — defence in depth for the plan's own rule
 * — that a pinned row is never superseded. Each row whose wording it wrote is
 * re-embedded. It returns what it committed: the rows it superseded and the
 * wording it wrote, for the digest.
 */
export const applyReflectionOps = internalMutation
    .input({ botId: v.optional(v.string()), ops: v.array(vReflectionOp), userId: v.string() })
    // One `promotedIds` entry per promote op, in order: `null` where the promotion was not made.
    .output(
        v.object({
            applied: v.number(),
            promotedIds: v.array(v.union(v.string(), v.null())),
            supersededIds: v.array(v.string()),
            written: v.array(v.object({ memory: v.string(), memoryId: v.string() })),
        }),
    )
    .mutation(async ({ args: { botId, ops, userId }, ctx }) => {
        const { now } = ctx;
        const promotedIds: (string | null)[] = [];
        const supersededIds: string[] = [];
        // The last wording written to each row.
        const written = new Map<Id<"memories">, string>();
        let applied = 0;

        // A row outside this scope is refused, so one scope's ops can never write another's rows.
        const active = async (id: string): Promise<Doc<"memories"> | null> => {
            const row = await ctx.db.get("memories", id as Id<"memories">);

            return row?.userId === userId && (row.botId as string | undefined) === botId && !row.supersededBy ? row : null;
        };

        // A merge applies whole or not at all: when its survivor was edited, or a row it absorbs was revised, deleted,
        // retired, pinned or given other dates after the plan read it, neither the survivor's new wording nor any retirement
        // of that merge is written, so no merged text overwrites the user's edit, outlives the fact it read or carries one the
        // user removed.
        const staleMerges = new Set<string>();
        const datesMoved = (row: Doc<"memories">, planned: { eventEnd?: string; eventStart?: string; validUntil?: string } | undefined): boolean =>
            planned !== undefined && !sameFactDates(factDatesOf(row), normalizeFactDates(planned));

        for (const op of ops) {
            if (op.kind === "patch" && op.readText !== undefined) {
                const row = await active(op.memoryId);

                if (row?.memory !== op.readText || datesMoved(row, op.checkDates?.memory)) {
                    staleMerges.add(op.memoryId);
                }

                continue;
            }

            if (op.kind !== "supersede" || op.merge !== true || op.absorbedText === undefined) {
                continue;
            }

            const row = await active(op.memoryId);

            if (!row || row.pinned === true || row.memory !== op.absorbedText || datesMoved(row, op.checkDates?.memory)) {
                staleMerges.add(op.byMemoryId);
            }
        }

        for (const op of ops) {
            switch (op.kind) {
                case "patch": {
                    const row = await active(op.memoryId);

                    if (!row || staleMerges.has(op.memoryId)) {
                        break;
                    }

                    // A wording planned for other dates than the row holds now is not written: a person's date edit wins.
                    if (op.checkDates && !sameFactDates(factDatesOf(row), normalizeFactDates(op.checkDates.memory))) {
                        break;
                    }

                    // The backstop: a wording that is nothing but a secret keeps the row's text; the rest of the patch applies.
                    const memory = op.memory === undefined ? undefined : (redactMemoryText(op.memory) ?? undefined);

                    await ctx.db.patch(
                        "memories",
                        row._id,
                        withoutUndefined({
                            confidence: op.confidence,
                            // A patch that is not a confirmation (decay) freezes the
                            // effective confirmation time, which would otherwise
                            // follow `updatedAt` forward.
                            lastConfirmedAt: op.lastConfirmedAt ?? lastConfirmedOf(row),
                            memory,
                            updatedAt: now,
                        }),
                    );

                    if (memory !== undefined && memory !== row.memory) {
                        written.set(row._id, memory);
                    }

                    applied += 1;
                    break;
                }
                case "promote": {
                    const rows = await Promise.all(op.sourceIds.map(async (id) => active(id)));
                    const read = new Map(op.sourceTexts?.map((source) => [source.id, source.memory]));
                    const sources = rows.filter(
                        (row): row is Doc<"memories"> => row !== null && row.pinned !== true && (read.get(row._id as string) ?? row.memory) === row.memory,
                    );
                    // A promotion that is nothing but a secret is not made, and its sources stay.
                    const memory = redactMemoryText(op.memory);
                    // Planned from undated activities: a source dated since is an occurrence, not a habit, so nothing is promoted.
                    const datedSince = sources.some((row) => hasFactDates(factDatesOf(row)));

                    // A source revised, deleted or pinned since the synthesis read it leaves the promotion unmade: the
                    // promoted wording still holds its old fact, and every source stays active for the next run.
                    if (sources.length === 0 || sources.length !== rows.length || memory === null || datedSince) {
                        promotedIds.push(null);
                        break;
                    }

                    const evidence = newestEvidence(sources);
                    const promotedId = await ctx.db.insert("memories", {
                        botId: botId as Id<"bots"> | undefined,
                        confidence: op.confidence,
                        // The newest words among the merged rows back the promoted one.
                        ...(evidence && { evidence }),
                        importance: op.importance,
                        lastConfirmedAt: now,
                        memory,
                        source: "reflection",
                        threadId: op.threadId as Id<"threads"> | undefined,
                        type: op.type,
                        updatedAt: now,
                        userId,
                        version: 1,
                    });

                    for (const source of sources) {
                        await ctx.db.patch("memories", source._id, { supersededBy: promotedId, updatedAt: now });
                        supersededIds.push(source._id);
                    }

                    promotedIds.push(promotedId);
                    written.set(promotedId, memory);
                    applied += 1;
                    break;
                }
                case "supersede": {
                    const row = await active(op.memoryId);
                    const by = op.byMemoryId === op.memoryId ? row : await active(op.byMemoryId);

                    // An expiry planned before a restatement moved the end date no longer holds. A merge whose absorbed row
                    // was revised since the plan read it is left out: its newer words are a different fact, and it stays
                    // active for the next run.
                    if (
                        !row ||
                        !by ||
                        row.pinned === true ||
                        (op.expiredOn !== undefined && !isExpired(row, op.expiredOn)) ||
                        (op.merge === true && staleMerges.has(op.byMemoryId))
                    ) {
                        break;
                    }

                    // A supersession decided on dates the rows no longer hold (a person edited one meanwhile) is not applied.
                    if (
                        op.checkDates &&
                        (!sameFactDates(factDatesOf(row), normalizeFactDates(op.checkDates.memory)) ||
                            !sameFactDates(factDatesOf(by), normalizeFactDates(op.checkDates.by)))
                    ) {
                        break;
                    }

                    await ctx.db.patch("memories", row._id, { supersededBy: by._id, updatedAt: now });

                    // The survivor takes the absorbed row's words when they were said later. Outside a merge, a survivor
                    // with no quote takes none: it is the newer belief that contradicts or reworded the absorbed one.
                    // Only a merge hands the absorbed row's words on: a replacing belief keeps its own quote, never the replaced one's.
                    // A survivor the user wrote (`manual`) takes none: its words are theirs, not anything they were quoted saying.
                    const evidence = by._id === row._id || op.merge !== true || by.source === "manual" ? undefined : newestEvidence([by, row]);

                    if (evidence !== undefined && evidence !== by.evidence) {
                        await ctx.db.patch("memories", by._id, { evidence });
                    }

                    supersededIds.push(row._id);
                    applied += 1;
                    break;
                }
                default: {
                    break;
                }
            }
        }

        // A later op may have superseded a row whose wording was written: it needs no vector of its own then.
        for (const memoryId of written.keys()) {
            if (!supersededIds.includes(memoryId)) {
                await reembedRewordedMemory(ctx, memoryId, userId);
            }
        }

        return {
            applied,
            promotedIds,
            supersededIds,
            written: [...written].map(([memoryId, memory]) => {
                return { memory, memoryId };
            }),
        };
    });

export const saveMemoryDigest = internalMutation
    .input({
        learned: v.array(v.object({ memory: v.string(), memoryId: v.string(), type: v.string() })),
        localDay: v.string(),
        stats: v.object({
            contradictionsResolved: v.number(),
            decayed: v.number(),
            merged: v.number(),
            newMemories: v.number(),
            promoted: v.number(),
            retired: v.number(),
        }),
        summary: v.string(),
        userId: v.string(),
    })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        await ctx.db.insert("memoryDigests", { ...args, createdAt: ctx.now });

        const older = await ctx.db
            .query("memoryDigests")
            .withIndex("by_userId_createdAt", (q) => q.eq("userId", args.userId))
            .order("desc")
            .take(DIGESTS_KEPT + 10);

        await Promise.all(older.slice(DIGESTS_KEPT).map((d) => ctx.db.delete("memoryDigests", d._id)));

        return null;
    });

// ============================================================================
// The run
// ============================================================================

const synthesisSchema = z.object({
    merges: z.array(z.object({ id: z.int(), text: z.string() })),
    promotions: z.array(z.object({ id: z.int(), text: z.string(), type: z.enum(["preference", "identity", "none"]) })),
    summary: z.string(),
});

type UtilityModel = Awaited<ReturnType<typeof getUtilityModel>>;
type ReflectionBudget = ReturnType<typeof createReflectionBudget>;

interface ScopeOutcome {
    applied: number;
    learned: { memory: string; memoryId: string; type: string }[];
    stats: { contradictionsResolved: number; decayed: number; merged: number; newMemories: number; promoted: number; retired: number };
    summary: string;
}

/**
 * One scope of the nightly reflection: the user's own memories (`botId` unset) or
 * one bot's. Each scope is planned, synthesised and written on its own, so no
 * merge, decay, promotion or contradiction ever crosses a scope. The LLM budget is
 * the caller's, shared across scopes.
 */
const reflectScope = async (
    ctx: ActionCtx,
    scope: { botId: string | undefined; budget: ReflectionBudget; model: UtilityModel | undefined; now: number; timeZone: string | undefined; userId: string },
): Promise<ScopeOutcome> => {
    const { botId, budget, model, now, timeZone, userId } = scope;
    const inputs = await ctx.runQuery(internal.memory.reflection.loadReflectionInputs, { botId, now, userId });
    // Expiry is read in the user's own calendar: a fact held "until the 20th" is retired on the 21st there.
    const today = localDayOf(now, timeZone);
    // The capped read plans the rest; expiry also sees every active row, page by page, so an old expired fact is retired.
    const expiredRows: ReflectionMemory[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < EXPIRY_READ_PAGES; page += 1) {
        const result: { continueCursor: string | null; expired: ReflectionMemory[]; isDone: boolean } = await ctx.runQuery(
            internal.memory.reflection.loadExpiredMemoriesPage,
            { botId, cursor, now, timeZone, userId },
        );

        expiredRows.push(...result.expired);

        if (result.isDone) {
            break;
        }

        cursor = result.continueCursor;
    }

    const everyRow = [...new Map([...inputs.memories, ...expiredRows].map((m) => [m.id, m])).values()];
    const { expire, live } = splitExpired(everyRow, today);
    const memories: ReflectionMemory[] = selectReflectionInputs(live, now, REFLECTION_LIMITS);
    const byId = new Map(memories.map((m) => [m.id, m]));
    const plan = planReflection(memories, now);
    const learnedToday = memories.filter((m) => m.createdAt >= now - DAY_MS);
    // Retirements for expiry are written apart, in bounded batches: a scope can hold thousands of expired rows.
    const expiryOps = expiryToOps(expire, today);
    const ops: ReflectionOp[] = decayToOps(plan);

    // 1. One synthesis call: merge wording, promotion decisions, the digest.
    let synthesis: z.infer<typeof synthesisSchema> | undefined;
    const needsSynthesis = plan.merges.length > 0 || plan.promotions.length > 0 || learnedToday.length > 0;

    if (model && needsSynthesis) {
        const prompt = buildReflectionPrompt({
            learnedToday: learnedToday.map((m) => m.text),
            merges: plan.merges,
            promotions: plan.promotions,
            threadTitles: inputs.threadTitles,
        });

        if (budget.tryReserve(estimateTokens(REFLECTION_SYSTEM_PROMPT + prompt))) {
            try {
                const result = await generateText({
                    maxOutputTokens: REFLECTION_LIMITS.maxOutputTokensPerCall,
                    model,
                    output: Output.object({ schema: synthesisSchema }),
                    prompt,
                    system: REFLECTION_SYSTEM_PROMPT,
                });

                synthesis = result.output ?? undefined;
            } catch (error) {
                console.warn("[memory/reflection] Synthesis call failed, keeping survivor wording:", error);
            }
        }
    }

    // Cut to length only after redaction (in `redactReflectionOps`), so a cut never hides the end of a secret.
    const mergedText = new Map((synthesis?.merges ?? []).map((m) => [m.id, m.text]));

    for (const [index, merge] of plan.merges.entries()) {
        ops.push(...mergeToOps(merge, byId, now, mergedText.get(index)));
    }

    const promotionDecisions = synthesis?.promotions ?? [];

    for (const decision of promotionDecisions) {
        const candidate = plan.promotions[decision.id];

        if (!candidate || decision.type === "none") {
            continue;
        }

        const op = promotionToOp(candidate, byId, { memory: decision.text, type: decision.type });

        if (op) {
            ops.push(op);
        }
    }

    // 2. Contradictions, through the extractor's own belief revision. Their merged text is stored whole, never cut.
    const revisedPairs: ContradictionCandidate[] = [];
    const revisionOps = new Set<ReflectionOp>();

    for (const pair of plan.contradictions) {
        if (!model || !budget.tryReserve(estimateTokens(pair.olderText + pair.newerText) + 200)) {
            break;
        }

        try {
            const older = byId.get(pair.olderId);
            const newer = byId.get(pair.newerId);
            // The newer row keeps its own dates: an UPDATE's merged wording is written for them when the two rows' differ.
            const newDates = older && newer && !sameFactDates(factDatesOf(older), factDatesOf(newer)) ? factDatesOf(newer) : undefined;
            const decision = await runBeliefRevision(model, pair.olderText, pair.newerText, REFLECTION_LIMITS.maxOutputTokensPerCall, newDates);
            const pairOps = revisionToOps(pair, decision, now, byId);

            if (pairOps.length > 0) {
                revisedPairs.push(pair);
                ops.push(...pairOps);

                for (const op of pairOps) {
                    revisionOps.add(op);
                }
            }
        } catch (error) {
            console.warn("[memory/reflection] Belief revision failed:", error);
        }
    }

    // 3. Write with secrets redacted, then re-embed whatever changed wording.
    const redaction = redactReflectionOps(ops, REFLECTION_LIMITS.maxMemoryChars, revisionOps);
    const writeOps = redaction.ops;

    logRedaction(ctx.log, "reflection", redaction);
    let expiryApplied = 0;
    const expirySuperseded: string[] = [];

    // A batch that fails does not stop the run, which still writes the rest and its digest. The batch is written again
    // on its own, without waiting for another run (which needs the user to be active): each retirement rechecks its row.
    for (let start = 0; start < expiryOps.length; start += EXPIRY_WRITE_BATCH) {
        const batchOps = expiryOps.slice(start, start + EXPIRY_WRITE_BATCH);

        try {
            const batch = await ctx.runMutation(internal.memory.reflection.applyReflectionOps, { botId, ops: batchOps, userId });

            expiryApplied += batch.applied;
            expirySuperseded.push(...batch.supersededIds);
        } catch (error) {
            console.warn("[memory/reflection] An expiry batch failed; retrying it on its own:", error);
            // On the owner's shard, where the rows live.
            await runAfterOnShard(
                ctx.scheduler,
                EXPIRY_RETRY_DELAY_MS,
                internal.memory.reflection.applyReflectionOps,
                { botId, ops: batchOps, userId },
                userId,
            );
        }
    }

    const result =
        writeOps.length > 0
            ? await ctx.runMutation(internal.memory.reflection.applyReflectionOps, { botId, ops: writeOps, userId })
            : { applied: 0, promotedIds: [] as (string | null)[], supersededIds: [] as string[], written: [] as { memory: string; memoryId: string }[] };

    // 4. What the digest says about this scope, from what the write committed: a source pinned meanwhile stays active
    // and is still listed, and a row it reworded is listed with its new wording.
    const superseded = new Set([...expirySuperseded, ...result.supersededIds]);
    const committed = new Map(result.written.map(({ memory, memoryId }) => [memoryId, memory]));
    const promoteOps = writeOps.filter((op): op is Extract<ReflectionOp, { kind: "promote" }> => op.kind === "promote");
    const committedOps = committedReflectionOps(writeOps, result.supersededIds);
    const learned = [
        ...promoteOps.flatMap((op, index) => {
            const memoryId = result.promotedIds[index];

            return memoryId ? [{ memory: committed.get(memoryId) ?? op.memory, memoryId, type: op.type as string }] : [];
        }),
        // A row written before redaction existed may still hold a secret: redacted here, left out when that is all it is.
        ...learnedToday
            .filter((m) => !superseded.has(m.id))
            .flatMap((m) => {
                const memory = committed.get(m.id) ?? redactMemoryText(m.text);

                return memory === null ? [] : [{ memory, memoryId: m.id, type: m.type as string }];
            }),
    ].slice(0, REFLECTION_LIMITS.maxDigestItems);

    return {
        applied: expiryApplied + result.applied,
        learned,
        stats: {
            // Counted from what is written: a revision whose wording was only a secret resolves nothing.
            contradictionsResolved: countResolvedContradictions(revisedPairs, committedOps),
            decayed: plan.decay.length,
            merged: countAppliedMerges(plan.merges, committedOps),
            newMemories: learnedToday.length,
            promoted: result.promotedIds.filter((id) => id !== null).length,
            // A retirement is a supersession of a row by itself (decay or expiry); count only those the write committed.
            retired: [...expiryOps, ...writeOps].filter((op) => op.kind === "supersede" && op.byMemoryId === op.memoryId && superseded.has(op.memoryId)).length,
        },
        summary: redactDigestSummary(synthesis?.summary ?? "", REFLECTION_LIMITS.maxSummaryChars),
    };
};

export const runMemoryReflection = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        // Read BEFORE the day is claimed: a settings read that fails throws here and leaves the day unclaimed, so the
        // job can run again. Run with no rules instead, the user's filters would be ignored and the day would be spent.
        const rules = await loadModelFilterRules(ctx, userId);
        const claim = await ctx.runMutation(internal.memory.reflection.claimReflectionRun, { userId });

        if (!claim.claimed) {
            ctx.log.event(REFLECTION_EVENT, { outcome: "skipped", reason: claim.reason, userId });

            return null;
        }

        const now = Date.now();
        // One budget and one model for the whole run: 100 bots must not mean 100 times the LLM calls.
        const budget = createReflectionBudget(REFLECTION_LIMITS);
        let model: UtilityModel | undefined;

        try {
            model = await getUtilityModel(gatewayFetch(ctx), { rules, userId });
        } catch (error) {
            console.warn("[memory/reflection] Utility model unavailable, applying the deterministic plan only:", error);
        }

        // The user's own memories first, then each bot's, each planned on its own.
        const botIds = await ctx.runQuery(internal.bots.functions.listBotIdsForUser, { userId });
        const userScope = await reflectScope(ctx, { botId: undefined, budget, model, now, timeZone: claim.timeZone, userId });
        const botScopes: ScopeOutcome[] = [];

        for (const botId of botIds) {
            try {
                botScopes.push(await reflectScope(ctx, { botId, budget, model, now, timeZone: claim.timeZone, userId }));
            } catch (error) {
                // One bot's failure must not skip the other bots or the user's digest.
                console.warn("[memory/reflection] A bot's reflection failed, continuing:", error);
            }
        }

        const applied = userScope.applied + botScopes.reduce((total, scope) => total + scope.applied, 0);

        // The digest describes the user's own memories. A bot's changes are logged, not summarised.
        // ponytail: a bot has no digest of its own; add one per bot when someone asks for it.
        const { learned, stats, summary } = userScope;

        if (learned.length > 0 || Object.values(stats).some((count) => count > 0)) {
            await ctx.runMutation(internal.memory.reflection.saveMemoryDigest, {
                learned,
                localDay: digestDayOf(now, claim.timeZone),
                stats,
                summary,
                userId,
            });
        }

        ctx.log.event(REFLECTION_EVENT, {
            applied,
            botScopes: botIds.length,
            llmCalls: budget.callsUsed,
            outcome: "ran",
            tokensReserved: budget.tokensUsed,
            userId,
            ...stats,
        });

        return null;
    });

// ============================================================================
// cRPC: the digest in the UI
// ============================================================================

/** The newest digest the user has not dismissed, or `null`. */
export const getLatestMemoryDigest = authQuery.output(v.union(vDigestView, v.null())).query(async ({ ctx }) => {
    const digests = await ctx.db
        .query("memoryDigests")
        .withIndex("by_userId_createdAt", (q) => q.eq("userId", ctx.user.userId))
        .order("desc")
        .take(DIGESTS_KEPT);
    const latest = digests.find((d) => d.dismissedAt === undefined);

    if (!latest) {
        return null;
    }

    return {
        _id: latest._id as string,
        createdAt: latest.createdAt,
        learned: latest.learned,
        localDay: latest.localDay,
        stats: latest.stats,
        summary: latest.summary,
    };
});

export const dismissMemoryDigest = authMutation
    .use(rateLimit("memory/update"))
    .input({ digestId: v.string().max(MAX_LENGTH.id) })
    .output(v.null())
    .mutation(async ({ args: { digestId }, ctx }) => {
        const digest = await ctx.db.get("memoryDigests", digestId as Id<"memoryDigests">);

        if (digest?.userId !== ctx.user.userId) {
            return null;
        }

        await ctx.db.patch("memoryDigests", digest._id, { dismissedAt: ctx.now });

        ctx.log.event("memory.dismiss_memory_digest", { dismissed: true });

        return null;
    });
