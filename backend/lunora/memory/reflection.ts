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
 * the local night window, and not already run for this local day. A late,
 * duplicated or stale job therefore does nothing.
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
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { patchRow, withoutUndefined } from "../lib/patch";
import { gatewayFetch } from "../lib/services";
import { getUtilityModel } from "../lib/utility-model";
import { runBeliefRevision } from "./extract";
import {
    buildReflectionPrompt,
    checkReflectionEligibility,
    createReflectionBudget,
    decayToOps,
    digestDayOf,
    estimateTokens,
    mergeToOps,
    nextReflectionRunAt,
    planActivityUpdate,
    planReflection,
    promotionToOp,
    REFLECTION_LIMITS,
    REFLECTION_SYSTEM_PROMPT,
    type ReflectionMemory,
    type ReflectionOp,
    revisionToOps,
    selectReflectionInputs,
} from "./reflection-logic";
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

        const now = ctx.now;
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
            await ctx.db.patch(state._id, { lastActiveAt: now, ...scheduled });
        } else {
            await ctx.db.insert("memoryReflectionState", { lastActiveAt: now, userId, ...scheduled });
        }

        return null;
    });

/**
 * Decides, when the job fires, whether this run happens — and if so claims the
 * local day so a duplicate cannot run too. The pending-job fields are cleared
 * either way, so the next activity schedules the next night.
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
        const now = ctx.now;
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
        const clearPending = state.scheduledFor !== undefined && state.scheduledFor > now ? {} : { scheduledFor: undefined, scheduledJobId: undefined };

        if (!eligibility.eligible) {
            await patchRow(ctx.db, state, clearPending);

            return { claimed: false as const, reason: eligibility.reason };
        }

        await patchRow(ctx.db, state, { ...clearPending, lastRunAt: now, lastRunLocalDay: eligibility.localDay });

        return { claimed: true as const, localDay: eligibility.localDay, ...(timeZone && { timeZone }) };
    });

// ============================================================================
// Inputs and writes
// ============================================================================

export const loadReflectionInputs = internalQuery
    .input({ now: v.number(), userId: v.string() })
    .output(
        v.object({
            memories: v.array(
                v.object({
                    confidence: v.number(),
                    createdAt: v.number(),
                    id: v.string(),
                    importance: v.number(),
                    lastConfirmedAt: v.number(),
                    pinned: v.boolean(),
                    text: v.string(),
                    threadId: v.optional(v.string()),
                    type: vReflectionMemoryType,
                    updatedAt: v.number(),
                }),
            ),
            threadTitles: v.array(v.string()),
        }),
    )
    .query(async ({ args: { now, userId }, ctx }) => {
        const rows = await ctx.db
            .query("memories")
            .withIndex("by_userId_type", (q) => q.eq("userId", userId))
            .take(REFLECTION_READ_CAP);
        const memories = rows
            .filter((m) => !m.supersededBy)
            .map((m) => {
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
                };
            });

        // "The day's threads": the ones that produced a memory in the last day.
        const since = now - DAY_MS;
        const threadIds = [...new Set(memories.filter((m) => m.createdAt >= since && m.threadId).map((m) => m.threadId!))].slice(
            0,
            REFLECTION_LIMITS.maxThreads,
        );
        const threads = await Promise.all(threadIds.map((id) => ctx.db.get(id as Id<"threads">)));
        const threadTitles = threads
            .filter((t): t is Doc<"threads"> => t !== null && t.userId === userId && t.isTemporary !== true && t.deleted !== true && !!t.title)
            .map((t) => t.title!);

        return { memories, threadTitles };
    });

const vReflectionOp = v.union(
    v.object({ byMemoryId: v.string(), kind: v.literal("supersede"), memoryId: v.string() }),
    v.object({
        confidence: v.optional(v.number()),
        kind: v.literal("patch"),
        lastConfirmedAt: v.optional(v.number()),
        memory: v.optional(v.string()),
        memoryId: v.string(),
    }),
    v.object({
        confidence: v.number(),
        importance: v.number(),
        kind: v.literal("promote"),
        memory: v.string(),
        sourceIds: v.array(v.string()),
        threadId: v.optional(v.string()),
        type: vReflectionMemoryType,
    }),
);

/**
 * Applies a run's writes. Every op re-reads its rows and re-checks ownership,
 * that the row is still active, and — defence in depth for the plan's own rule
 * — that a pinned row is never superseded.
 */
export const applyReflectionOps = internalMutation
    .input({ ops: v.array(vReflectionOp), userId: v.string() })
    .output(v.object({ applied: v.number(), promotedIds: v.array(v.string()), textChangedIds: v.array(v.string()) }))
    .mutation(async ({ args: { ops, userId }, ctx }) => {
        const now = ctx.now;
        const promotedIds: string[] = [];
        const textChangedIds: string[] = [];
        let applied = 0;

        const active = async (id: string): Promise<Doc<"memories"> | null> => {
            const row = await ctx.db.get(id as Id<"memories">);

            return row?.userId === userId && !row.supersededBy ? row : null;
        };

        for (const op of ops) {
            switch (op.kind) {
                case "patch": {
                    const row = await active(op.memoryId);

                    if (!row) {
                        break;
                    }

                    await ctx.db.patch(
                        row._id,
                        withoutUndefined({
                            confidence: op.confidence,
                            // A patch that is not a confirmation (decay) freezes the
                            // effective confirmation time, which would otherwise
                            // follow `updatedAt` forward.
                            lastConfirmedAt: op.lastConfirmedAt ?? lastConfirmedOf(row),
                            memory: op.memory,
                            updatedAt: now,
                        }),
                    );

                    if (op.memory !== undefined && op.memory !== row.memory) {
                        textChangedIds.push(row._id);
                    }

                    applied += 1;
                    break;
                }
                case "promote": {
                    const rows = await Promise.all(op.sourceIds.map(async (id) => active(id)));
                    const sources = rows.filter((row): row is Doc<"memories"> => row !== null && row.pinned !== true);

                    if (sources.length === 0) {
                        break;
                    }

                    const promotedId = await ctx.db.insert("memories", {
                        confidence: op.confidence,
                        importance: op.importance,
                        lastConfirmedAt: now,
                        memory: op.memory,
                        source: "reflection",
                        threadId: op.threadId as Id<"threads"> | undefined,
                        type: op.type,
                        updatedAt: now,
                        userId,
                        version: 1,
                    });

                    for (const source of sources) {
                        await ctx.db.patch(source._id, { supersededBy: promotedId, updatedAt: now });
                    }

                    promotedIds.push(promotedId);
                    textChangedIds.push(promotedId);
                    applied += 1;
                    break;
                }
                case "supersede": {
                    const row = await active(op.memoryId);
                    const by = op.byMemoryId === op.memoryId ? row : await active(op.byMemoryId);

                    if (!row || !by || row.pinned === true) {
                        break;
                    }

                    await ctx.db.patch(row._id, { supersededBy: by._id, updatedAt: now });
                    applied += 1;
                    break;
                }
                default: {
                    break;
                }
            }
        }

        return { applied, promotedIds, textChangedIds };
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

        await Promise.all(older.slice(DIGESTS_KEPT).map((d) => ctx.db.delete(d._id)));

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

export const runMemoryReflection = internalAction
    .input({ userId: v.string() })
    .output(v.null())
    .action(async ({ args: { userId }, ctx }) => {
        const claim = await ctx.runMutation(internal.memory.reflection.claimReflectionRun, { userId });

        if (!claim.claimed) {
            ctx.log.event(REFLECTION_EVENT, { outcome: "skipped", reason: claim.reason, userId });

            return null;
        }

        const now = Date.now();
        const inputs = await ctx.runQuery(internal.memory.reflection.loadReflectionInputs, { now, userId });
        const memories: ReflectionMemory[] = selectReflectionInputs(inputs.memories, now, REFLECTION_LIMITS);
        const byId = new Map(memories.map((m) => [m.id, m]));
        const plan = planReflection(memories, now);
        const learnedToday = memories.filter((m) => m.createdAt >= now - DAY_MS);
        const budget = createReflectionBudget(REFLECTION_LIMITS);
        const ops: ReflectionOp[] = decayToOps(plan);

        let model: Awaited<ReturnType<typeof getUtilityModel>> | undefined;

        try {
            model = await getUtilityModel(gatewayFetch(ctx), { userId });
        } catch (error) {
            console.warn("[memory/reflection] Utility model unavailable, applying the deterministic plan only:", error);
        }

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

        const mergedText = new Map((synthesis?.merges ?? []).map((m) => [m.id, m.text.slice(0, REFLECTION_LIMITS.maxMemoryChars)]));

        for (const [index, merge] of plan.merges.entries()) {
            ops.push(...mergeToOps(merge, byId, now, mergedText.get(index)));
        }

        const promotionDecisions = synthesis?.promotions ?? [];

        for (const decision of promotionDecisions) {
            const candidate = plan.promotions[decision.id];

            if (!candidate || decision.type === "none") {
                continue;
            }

            const op = promotionToOp(candidate, byId, { memory: decision.text.slice(0, REFLECTION_LIMITS.maxMemoryChars), type: decision.type });

            if (op) {
                ops.push(op);
            }
        }

        // 2. Contradictions, through the extractor's own belief revision.
        let contradictionsResolved = 0;

        for (const pair of plan.contradictions) {
            if (!model || !budget.tryReserve(estimateTokens(pair.olderText + pair.newerText) + 200)) {
                break;
            }

            try {
                const decision = await runBeliefRevision(model, pair.olderText, pair.newerText, REFLECTION_LIMITS.maxOutputTokensPerCall);
                const revisionOps = revisionToOps(pair, decision, now);

                if (revisionOps.length > 0) {
                    contradictionsResolved += 1;
                    ops.push(...revisionOps);
                }
            } catch (error) {
                console.warn("[memory/reflection] Belief revision failed:", error);
            }
        }

        // 3. Write, then re-embed whatever changed wording.
        const result =
            ops.length > 0
                ? await ctx.runMutation(internal.memory.reflection.applyReflectionOps, { ops, userId })
                : { applied: 0, promotedIds: [] as string[], textChangedIds: [] as string[] };

        for (const memoryId of result.textChangedIds) {
            await ctx.scheduler.runAfter(0, internal.memory.extract.regenerateMemoryEmbedding, { memoryId: memoryId as Id<"memories">, userId });
        }

        // 4. The digest.
        const superseded = new Set(
            ops.flatMap((op) => {
                if (op.kind === "supersede") {
                    return [op.memoryId];
                }

                return op.kind === "promote" ? op.sourceIds : [];
            }),
        );
        const promoteOps = ops.filter((op): op is Extract<ReflectionOp, { kind: "promote" }> => op.kind === "promote");
        const learned = [
            ...promoteOps.flatMap((op, index) => {
                const memoryId = result.promotedIds[index];

                return memoryId ? [{ memory: op.memory, memoryId, type: op.type as string }] : [];
            }),
            ...learnedToday
                .filter((m) => !superseded.has(m.id))
                .map((m) => {
                    return { memory: m.text, memoryId: m.id, type: m.type as string };
                }),
        ].slice(0, REFLECTION_LIMITS.maxDigestItems);
        const stats = {
            contradictionsResolved,
            decayed: plan.decay.length,
            merged: plan.merges.length,
            newMemories: learnedToday.length,
            promoted: result.promotedIds.length,
            retired: plan.retire.length,
        };

        if (learned.length > 0 || Object.values(stats).some((count) => count > 0)) {
            await ctx.runMutation(internal.memory.reflection.saveMemoryDigest, {
                learned,
                localDay: digestDayOf(now, claim.timeZone),
                stats,
                summary: (synthesis?.summary ?? "").trim().slice(0, REFLECTION_LIMITS.maxSummaryChars),
                userId,
            });
        }

        ctx.log.event(REFLECTION_EVENT, {
            applied: result.applied,
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
        const digest = await ctx.db.get(digestId as Id<"memoryDigests">);

        if (digest?.userId !== ctx.user.userId) {
            return null;
        }

        await ctx.db.patch(digest._id, { dismissedAt: ctx.now });

        ctx.log.event("memory.dismiss_memory_digest", { dismissed: true });

        return null;
    });
