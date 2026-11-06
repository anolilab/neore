/**
 * Summaries of a long thread's older turns, made while the thread sits idle.
 *
 * ## Flow
 *
 * `afterRun` schedules {@link runThreadSummary} {@link SUMMARY_IDLE_MS} after a
 * reply, naming the last row the reply saved. The job is the debounce: it
 * exits when that row is no longer the thread's latest, or a run is still
 * streaming — a newer reply scheduled its own job. It then
 *
 * 1. {@link prepareThreadSummary} (one mutation): checks the thread may be
 *    summarised, finds the previous summary ON THIS PATH, plans how many rows to
 *    fold in (`thread-summary-logic.ts`) and claims the cut;
 * 2. makes ONE utility-model call over the previous summary and those rows,
 *    metered by the gateway against the thread owner like the title and category
 *    jobs;
 * 3. {@link finishThreadSummary} (one mutation): re-checks the thread and
 *    stores the row, replacing the one it extended.
 *
 * The claim (`idempotencyClaims`, keyed on thread + last covered row) is what
 * makes a redelivered job do nothing twice. It is released when the model call
 * fails, so the next reply's job can try the same cut.
 *
 * ## What guards the result
 *
 * - **Opt-in** (`userSettings.threadSummariesEnabled === true`); switching it off
 *   erases the user's summaries ({@link eraseUserThreadSummaries}).
 * - **Taint.** Each row records the untrusted sources of the rows it folded plus
 *   the previous summary's (`taintedBy`); `getDeviceToolContext` snapshots them
 *   when the run's tool set is built and `createDeviceCall` unions that with a fresh
 *   re-read, so a summary of web or tool content still makes a device call ask even
 *   when it was committed after the snapshot.
 * - **Epoch.** An in-place edit moves `threads.summaryEpoch` and erases the
 *   summaries covering the edited turns ({@link dropSummariesFromEdit}); a run
 *   prepared before it refuses to store.
 * - **Cost.** A path past `SUMMARY_MAX_PATH_ROWS` is never read from the top:
 *   `threads.summaryPathTooLongAt` makes later jobs skip it, and an extending walk
 *   stops at the previous cover.
 *
 * ## Reading
 *
 * {@link getThreadSummaryForContext} answers the context builder
 * (`agent/client/search.ts`): the newest summary whose last covered row is an
 * ancestor of the prompt, or nothing. It reaches the model as notes in the
 * system prompt, not as a message. A summary of another branch is never
 * used, and a locked thread has none (the lock paths erase them).
 *
 * ## Compactions
 *
 * A row with `kind: "compact"` (`thread-compaction.ts`) is a summary the owner asked for. The same table, claim and
 * finish path store it, but it is also a BOUNDARY the reader returns (the context builder drops the rows it
 * covers), it is gated by {@link hardBlockerOf} alone (no opt-in), and the opt-out erase leaves it. The idle
 * summariser never extends one: its text would then be stored as a compaction and outlive the opt-out. While the
 * reader still reaches a compaction, no idle summary is made on its path; past that reach a new idle row starts after
 * its cover, seeded with the notes the reader last sent, and the compaction row stays as it was.
 */
import { generateText } from "ai";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { type ActionCtx, internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { computeTaint, type DeviceTaintSource, mergeTaint } from "../devices/lib/taint";
import { messagesCarryAttachedText } from "../chat/lib/attached-text";
import { vDeviceTaintSource } from "../devices/validators";
import { claimedAtOf, claimFence, releaseClaim } from "../lib/claim-once";
import { runAfterOnShard } from "../lib/shard-scheduler";
import { loadModelFilterRules } from "../chat/lib/model-filter-rules";
import { gatewayFetch } from "../lib/services";
import { isThreadLocked } from "../lib/thread-lock";
import { getUtilityModel } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { getThreadRow, resolveLeafRow, walkPath } from "./branch-rows";
import { THREAD_CUT_CLAIM_SCOPE, THREAD_FOLD_CLAIM_SCOPE, THREAD_FOLD_CLAIM_TTL_MS, type CompactionBoundary } from "./thread-compaction-logic";
import {
    buildSummaryPrompt,
    clampSummary,
    planSummary,
    renderTranscript,
    SUMMARIES_KEPT_PER_THREAD,
    SUMMARY_MAX_OUTPUT_TOKENS,
    SUMMARY_MAX_PATH_ROWS,
    SUMMARY_READ_REACH_ROWS,
    SUMMARY_SYSTEM_PROMPT,
    SUMMARY_TOO_LONG_RECHECK_MS,
    THREAD_SUMMARY_CLAIM_TTL_MS,
} from "./thread-summary-logic";

/** Attached document or page text is a plain user text part `computeTaint` cannot see, and the summary no longer shows it. */
export const foldedTaint = (rows: ReadonlyArray<{ content?: unknown; role?: unknown }>): DeviceTaintSource[] =>
    mergeTaint(computeTaint(rows), messagesCarryAttachedText(rows) ? ["files"] : []);

type Reader = Pick<QueryCtx, "db">;
type Row = Doc<"messages">;
type Thread = Doc<"threads">;
export type OwnedThread = Thread & { userId: string };

const SUMMARY_EVENT = "chat.thread_summary";

const ERASE_BATCH = 50;

/** The summarising call's deadline; it writes at most `SUMMARY_MAX_OUTPUT_TOKENS`, so a minute is ample. */
const SUMMARY_CALL_TIMEOUT_MS = 60_000;

export const STORAGE_ORDER_DESC = [{ order: "desc" }, { stepOrder: "desc" }, { _creationTime: "desc" }] as const;

export const claimKey = (threadId: string, coveredUpToMessageId: string): string => `${threadId}:${coveredUpToMessageId}`;

/**
 * Claims a cut before its paid summarising call: the cut itself (`<thread>:<covered row>`, kept with the stored row so a
 * redelivery does nothing twice) and the thread's one fold in flight. An idle summary and a compaction, or two
 * compactions anchored on different rows, plan DIFFERENT cuts of the same rows; only one of them may pay, and the one
 * refused here skips before its call. Returns both claims' fences for `finishThreadSummary`, or `null` when either is held.
 */
export const claimCut = async (
    ctx: Pick<MutationCtx, "db">,
    threadId: Id<"threads">,
    coveredUpToMessageId: Id<"messages">,
    userId: string,
): Promise<{ cutClaimedAt: number; foldClaimedAt: number } | null> => {
    const foldClaimedAt = await claimFence(ctx, THREAD_FOLD_CLAIM_SCOPE, threadId, { ttlMs: THREAD_FOLD_CLAIM_TTL_MS, userId });

    if (foldClaimedAt === null) {
        return null;
    }

    const cutClaimedAt = await claimFence(ctx, THREAD_CUT_CLAIM_SCOPE, claimKey(threadId, coveredUpToMessageId), {
        ttlMs: THREAD_SUMMARY_CLAIM_TTL_MS,
        userId,
    });

    if (cutClaimedAt === null) {
        await releaseClaim(ctx, THREAD_FOLD_CLAIM_SCOPE, threadId, foldClaimedAt);

        return null;
    }

    return { cutClaimedAt, foldClaimedAt };
};

/**
 * Erases one summary row and the claim on its cut. Once the row is gone the same cut can be planned again (after an edit,
 * an unlock, a re-enable), and a claim left in place would refuse that as `busy` until it expired.
 */
const eraseSummaryRow = async (ctx: Pick<MutationCtx, "db">, row: Doc<"threadContextSummaries">): Promise<void> => {
    await ctx.db.delete("threadContextSummaries", row._id);
    await releaseClaim(ctx, THREAD_CUT_CLAIM_SCOPE, claimKey(row.threadId, row.coveredUpToMessageId));
};

/** The thread, when it has an owner to bill and attribute the summary to. */
export const ownedBy = (thread: Thread | null): OwnedThread | null => (thread?.userId ? (thread as OwnedThread) : null);

/**
 * Why the thread must not be summarised or compacted, or `null` when it may. These hold for both kinds of
 * summary; an idle summary also needs the opt-in ({@link blockerOf}).
 */
export const hardBlockerOf = (thread: OwnedThread): string | null => {
    if (thread.deleted === true) {
        return "deleted";
    }

    // A temporary chat is meant to leave nothing behind; a locked one's content is not read by background work.
    if (thread.isTemporary === true) {
        return "temporary";
    }

    if (isThreadLocked(thread)) {
        return "locked";
    }

    // Stateless chats keep no history; host-run threads are the coding agent's own; a group chat builds its own history.
    if (thread.statelessMode === true || thread.runner === "host" || thread.groupChat !== undefined) {
        return "unsupported";
    }

    return null;
};

/** Whether the owner switched idle summaries on. OPT-IN, like memory: absent means off. */
export const summariesOptedIn = async (ctx: Reader, thread: OwnedThread): Promise<boolean> => {
    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", thread.userId))
        .first();

    return settings?.threadSummariesEnabled === true;
};

/** Why an IDLE summary must not be made or read for the thread, or `null` when it may. */
const blockerOf = async (ctx: Reader, thread: OwnedThread): Promise<string | null> =>
    hardBlockerOf(thread) ?? ((await summariesOptedIn(ctx, thread)) ? null : "disabled");

/** Of `candidates` (rows of a thread), the ids that are `tip` or among its `reach` nearest ancestors. */
const ancestorIds = async (ctx: Reader, threadId: Id<"threads">, tip: Row, candidates: ReadonlyArray<Row>, reach: number): Promise<Set<string>> => {
    if (candidates.length === 0) {
        return new Set();
    }

    const wanted = new Set(candidates.map((row) => row._id as string));
    const { rows } = await walkPath(ctx, threadId, tip, { limit: reach, stopBelowOrder: Math.min(...candidates.map((row) => row.order)) });

    return new Set(rows.map((row) => row._id as string).filter((id) => wanted.has(id)));
};

export const summariesOf = async (ctx: Reader, threadId: Id<"threads">): Promise<Doc<"threadContextSummaries">[]> =>
    await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(SUMMARIES_KEPT_PER_THREAD + 2);

/**
 * The summaries of `threadId` whose last covered row is an ancestor of `tip`
 * within `reach` rows (`tip` itself does not count), each with that row, the one
 * covering the most first. A covered row that is gone (deleted) disqualifies its summary.
 */
export const summariesOnPath = async (
    ctx: Reader,
    threadId: Id<"threads">,
    tip: Row,
    summaries: ReadonlyArray<Doc<"threadContextSummaries">>,
    reach: number,
): Promise<{ covered: Row; summary: Doc<"threadContextSummaries"> }[]> => {
    const loaded = await Promise.all(
        summaries.map(async (summary) => {
            return { covered: await getThreadRow(ctx, threadId, summary.coveredUpToMessageId), summary };
        }),
    );
    const present = loaded.filter((entry): entry is { covered: Row; summary: Doc<"threadContextSummaries"> } => entry.covered !== null);
    const onPath = await ancestorIds(
        ctx,
        threadId,
        tip,
        present.map((entry) => entry.covered),
        reach,
    );

    return present
        .filter((entry) => onPath.has(entry.covered._id as string) && entry.covered._id !== tip._id)
        .toSorted((a, b) => b.summary.coveredCount - a.summary.coveredCount);
};

type SummaryOnPath = Awaited<ReturnType<typeof summariesOnPath>>[number];

/**
 * The idle summary read BESIDE `compaction` (both from one {@link summariesOnPath} list): the one ending highest above the
 * compaction's cover. A compaction folds from just after it (`prepareThreadCompaction`), so the two notes cover the
 * path end to end; without it the turns the idle summary stood in for would leave the model's context.
 */
export const idleSummaryAbove = (onPath: ReadonlyArray<SummaryOnPath>, compaction: SummaryOnPath): SummaryOnPath | undefined =>
    onPath.find(
        (entry) =>
            entry.summary.kind !== "compact" &&
            (entry.covered.order < compaction.covered.order ||
                (entry.covered.order === compaction.covered.order && entry.covered.stepOrder < compaction.covered.stepOrder)),
    );

/** The row the thread's active path ends at. */
export const leafOf = async (ctx: Reader, thread: Thread, latest: Row | null): Promise<Row | null> =>
    thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : latest;

export const preparedValidator = v.object({
    coveredCount: v.number(),
    coveredUpToMessageId: v.id("messages"),
    /** The fences of the claims this run holds (`claimCut`): its cut, and the thread's one fold in flight. */
    cutClaimedAt: v.number(),
    /** `threads.summaryEpoch` as the run was prepared; storing the summary needs it unchanged. */
    epoch: v.number(),
    foldClaimedAt: v.number(),
    previousSummary: v.optional(v.string()),
    previousSummaryId: v.optional(v.id("threadContextSummaries")),
    taintedBy: v.array(vDeviceTaintSource),
    transcript: v.string(),
    userId: v.string(),
});

/** Whether the reader, answering `tip`, still reaches `summary`'s cover. */
const readWithin = async (ctx: Reader, threadId: Id<"threads">, tip: Row, summary: Doc<"threadContextSummaries">): Promise<boolean> => {
    const reached = await summariesOnPath(ctx, threadId, tip, [summary], SUMMARY_READ_REACH_ROWS);

    return reached.length > 0;
};

/** Marks the thread so later jobs skip reading its path from the top. */
const markPathTooLong = async (ctx: MutationCtx, thread: Thread): Promise<null> => {
    await ctx.db.patch("threads", thread._id, { summaryPathTooLongAt: ctx.now });

    return null;
};

/**
 * Everything one summarising run needs, or `null` when there is nothing to do
 * now. Claims the cut, so a second delivery of the job gets `null`.
 */
export const prepareThreadSummary = internalMutation
    .input({ afterMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.union(preparedValidator, v.null()))
    .mutation(async ({ args, ctx }) => {
        const thread = ownedBy(await ctx.db.get("threads", args.threadId));

        // A thread found too long is not read again for a while: its jobs do not even look at its rows.
        if (!thread || (thread.summaryPathTooLongAt !== undefined && ctx.now - thread.summaryPathTooLongAt < SUMMARY_TOO_LONG_RECHECK_MS)) {
            return null;
        }

        if ((await blockerOf(ctx, thread)) !== null) {
            return null;
        }

        // Idle since the reply: the reply's last row still ends the ACTIVE path, and nothing is streaming. Another
        // branch may hold rows of a later order (a regenerate of an earlier turn), so the newest row of the whole
        // thread is the leaf only before the thread ever branched.
        const latest = thread.activeLeafMessageId
            ? null
            : ((await ctx.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_DESC], where: { threadId: thread._id } })) as Row | null);
        const leaf = await leafOf(ctx, thread, latest);

        if (!leaf || leaf._id !== args.afterMessageId) {
            return null;
        }

        if (await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id } })) {
            return null;
        }

        // Every turn adds at least one row to the path, so this many turns is too long without reading a row.
        if (leaf.order >= SUMMARY_MAX_PATH_ROWS) {
            return await markPathTooLong(ctx, thread);
        }

        const onPath = await summariesOnPath(ctx, thread._id, leaf, await summariesOf(ctx, thread._id), SUMMARY_MAX_PATH_ROWS);
        const [base] = onPath;
        const compaction = base?.summary.kind === "compact" ? base : undefined;

        // A compaction the reader still reads is extended only by another compaction: an idle summary covering more
        // would outrank it and drop its boundary.
        if (compaction && (await readWithin(ctx, thread._id, leaf, compaction.summary))) {
            return null;
        }

        // Past the reader's reach the compaction is read no more, so a NEW idle summary starts after its cover from
        // the notes the reader last sent (`getThreadSummaryForContext`). The compaction row itself stays as it is
        // (`finishThreadSummary` never replaces one), so the opt-out erase still leaves exactly the owner's rows.
        const older = compaction ? idleSummaryAbove(onPath, compaction) : undefined;
        const previousSummary = older ? `${older.summary.summary}\n\n${base?.summary.summary}` : base?.summary.summary;

        const { next, rows } = await walkPath(ctx, thread._id, leaf, {
            limit: SUMMARY_MAX_PATH_ROWS,
            ...(base && { stopAtId: base.covered._id as string, stopBelowOrder: base.covered.order }),
        });

        // Too long to read from the top: keep today's behaviour, and do not walk it again.
        if (rows.length >= SUMMARY_MAX_PATH_ROWS) {
            return await markPathTooLong(ctx, thread);
        }

        // The walk did not reach the previous cover.
        if (base && next?._id !== base.covered._id) {
            return null;
        }

        // The window shows successful rows only (`fetchRecentAndSearchMessages`), so the plan counts those.
        const after = rows.toReversed().filter((row) => row.status === "success");
        const plan = planSummary(after.length, base?.summary.coveredCount);

        if (!plan) {
            return null;
        }

        const slice = after.slice(0, plan.take);
        const { consumed, text } = renderTranscript(
            slice.map((row) => {
                const role = (row.message as { role?: string } | undefined)?.role ?? "assistant";

                // A tool result has no words of its own; an assistant row that also called a tool keeps its text.
                return { role, text: role === "tool" ? undefined : row.text };
            }),
        );
        const covered = slice[consumed - 1];

        if (!covered) {
            return null;
        }

        const claims = await claimCut(ctx, thread._id, covered._id, thread.userId);

        if (claims === null) {
            return null;
        }

        return {
            coveredCount: (base?.summary.coveredCount ?? 0) + consumed,
            coveredUpToMessageId: covered._id,
            epoch: thread.summaryEpoch ?? 0,
            ...claims,
            ...(base && previousSummary !== undefined && { previousSummary, previousSummaryId: base.summary._id }),
            // Whatever untrusted content the folded rows held, and the previous notes already carried.
            taintedBy: mergeTaint(
                mergeTaint(foldedTaint(slice.slice(0, consumed).map((row) => row.message as { content?: unknown; role?: unknown })), base?.summary.taintedBy),
                older?.summary.taintedBy,
            ),
            transcript: text,
            userId: thread.userId,
        };
    });

/**
 * Whether a compaction newer than the run's base stands on the path an idle summary covering `coveredId` would be read
 * on: above its cover, or on the active path. The base (`baseCount`, what the summary it extends covers, 0 for none)
 * outranked every compaction on the path when the run was prepared, or was itself the compaction it rolls on from;
 * one that landed since covers more, and an idle summary stored over it could bring back the turns it replaced.
 */
const compactionOnIdlePath = async (
    ctx: Reader,
    thread: OwnedThread,
    coveredId: Id<"messages">,
    existing: ReadonlyArray<Doc<"threadContextSummaries">>,
    baseCount: number,
): Promise<boolean> => {
    const compactions = existing.filter((row) => row.kind === "compact" && row.coveredCount > baseCount);

    if (compactions.length === 0) {
        return false;
    }

    const latest = thread.activeLeafMessageId
        ? null
        : ((await ctx.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_DESC], where: { threadId: thread._id } })) as Row | null);
    const tips = [await leafOf(ctx, thread, latest), await getThreadRow(ctx, thread._id, coveredId)];

    for (const tip of tips) {
        const onPath = tip ? await summariesOnPath(ctx, thread._id, tip, compactions, SUMMARY_MAX_PATH_ROWS) : [];

        if (onPath.length > 0) {
            return true;
        }
    }

    return false;
};

/**
 * Stores the summary and drops the one it extends, keeping the newest few of
 * other branches. With no `summary` the run failed and only its claim goes, so
 * the next reply's job can try the same cut again. An empty `summary` is a cover
 * with nothing to say yet (the rows had no text): it moves the cut on, and the
 * agent reads nothing from it.
 */
export const finishThreadSummary = internalMutation
    .input({
        coveredCount: v.number(),
        coveredUpToMessageId: v.id("messages"),
        /** The run's cut claim (`claimCut`): released by fence, so a newer claim on the same cut is left alone. */
        cutClaimedAt: v.optional(v.number()),
        epoch: v.number(),
        /** The run's fold claim (`claimCut`): a run that no longer holds it stores nothing; released either way. */
        foldClaimedAt: v.optional(v.number()),
        /** `"compact"` stores a compaction (`agent/thread-compaction.ts`): its claim scope and gate differ, see below. */
        kind: v.optional(v.literal("compact")),
        previousSummaryId: v.optional(v.id("threadContextSummaries")),
        summary: v.optional(v.string().max(MAX_LENGTH.long)),
        taintedBy: v.array(vDeviceTaintSource),
        threadId: v.id("threads"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const releaseCut = async () => await releaseClaim(ctx, THREAD_CUT_CLAIM_SCOPE, claimKey(args.threadId, args.coveredUpToMessageId), args.cutClaimedAt);
        // A run that outlived its fold claim may share the thread with a newer run by now, which holds the claim: it
        // stores nothing, and its fenced releases leave that run's claims alone.
        const lapsed = args.foldClaimedAt !== undefined && (await claimedAtOf(ctx, THREAD_FOLD_CLAIM_SCOPE, args.threadId)) !== args.foldClaimedAt;

        if (args.foldClaimedAt !== undefined) {
            await releaseClaim(ctx, THREAD_FOLD_CLAIM_SCOPE, args.threadId, args.foldClaimedAt);
        }

        if (args.summary === undefined || lapsed) {
            await releaseCut();

            return false;
        }

        // The model call took a while: the thread may have been locked, deleted or opted out meanwhile.
        const thread = ownedBy(await ctx.db.get("threads", args.threadId));

        // Refused after the model call: the claim goes too, so a job after a re-enable or an unlock retries at once.
        const refuse = async (): Promise<false> => {
            await releaseCut();

            return false;
        };

        // A compaction was asked for by the owner, so it does not depend on the idle-summary opt-in.
        if (!thread || (args.kind === "compact" ? hardBlockerOf(thread) : await blockerOf(ctx, thread)) !== null) {
            return await refuse();
        }

        // A reply was edited in place since the run was prepared: the rows it read are not the rows there now.
        if ((thread.summaryEpoch ?? 0) !== args.epoch) {
            return await refuse();
        }

        const existing = await summariesOf(ctx, args.threadId);

        // Idempotent on the cut: a second delivery found it stored, and its claim stays with it.
        if (existing.some((row) => row.coveredUpToMessageId === args.coveredUpToMessageId)) {
            return false;
        }

        // The summary it extends moved since the run was prepared.
        if (args.previousSummaryId && existing.every((row) => row._id !== args.previousSummaryId)) {
            return await refuse();
        }

        // An idle run prepared before a compaction landed on its path: stored now, it could outrank the compaction and
        // bring the turns it replaced back. The same rule as preparing one, checked again in the writing mutation.
        const baseCount = existing.find((row) => row._id === args.previousSummaryId)?.coveredCount ?? 0;

        if (args.kind !== "compact" && (await compactionOnIdlePath(ctx, thread, args.coveredUpToMessageId, existing, baseCount))) {
            return await refuse();
        }

        await ctx.db.insert("threadContextSummaries", {
            coveredCount: args.coveredCount,
            coveredUpToMessageId: args.coveredUpToMessageId,
            createdAt: ctx.now,
            ...(args.kind && { kind: args.kind }),
            summary: args.summary,
            taintedBy: args.taintedBy,
            threadId: args.threadId,
            userId: thread.userId,
        });

        // The row it extends is replaced, unless it is a compaction an idle summary rolls on from: that row is the
        // owner's and stays. Of the other branches' rows the newest few stay.
        const others = existing.filter((row) => row._id !== args.previousSummaryId).toSorted((a, b) => b.createdAt - a.createdAt);
        // A compaction starts from the idle summary above its cover when it skipped the turns that summary holds: those
        // notes stand beside it, so they stay even when newer summaries of other branches would evict them.
        const dependedOn = new Set<string>();

        if (args.kind === "compact") {
            const coveredRow = await getThreadRow(ctx, args.threadId, args.coveredUpToMessageId);
            const onPath = coveredRow ? await summariesOnPath(ctx, args.threadId, coveredRow, others, SUMMARY_READ_REACH_ROWS) : [];

            for (const found of onPath) {
                dependedOn.add(found.summary._id);
            }
        }

        const stale = [
            ...existing.filter((row) => row._id === args.previousSummaryId && (row.kind !== "compact" || args.kind === "compact")),
            ...others.slice(SUMMARIES_KEPT_PER_THREAD - 1).filter((row) => !dependedOn.has(row._id)),
        ];

        for (const row of stale) {
            await eraseSummaryRow(ctx, row);
        }

        return true;
    });

/**
 * ONE utility-model call that folds `transcript` into `previous`, metered by the gateway against `userId` and the
 * thread. Throws when the call fails or times out; the caller releases its claim.
 */
export const summariseTranscript = async (
    ctx: ActionCtx,
    args: {
        /** Runs once the utility model is resolved, just before the call: a charge for the call goes here, not before a model that cannot be used. */
        beforeCall?: () => Promise<void>;
        previous: string | undefined;
        signal?: AbortSignal;
        threadId: Id<"threads">;
        transcript: string;
        userId: string;
    },
): Promise<string> => {
    const model = await getUtilityModel(gatewayFetch(ctx), {
        rules: await loadModelFilterRules(ctx, args.userId),
        threadId: args.threadId,
        userId: args.userId,
    });

    await args.beforeCall?.();

    const result = await generateText({
        // A stalled gateway call must not hold the caller's lane (a scheduler job or a reply): it fails, and the cut is released.
        // The caller's signal ends it early too (a stopped reply, or one a newer run replaced).
        abortSignal: AbortSignal.any([AbortSignal.timeout(SUMMARY_CALL_TIMEOUT_MS), ...(args.signal ? [args.signal] : [])]),
        maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
        model,
        prompt: buildSummaryPrompt(args.previous, args.transcript),
        system: SUMMARY_SYSTEM_PROMPT,
    });

    ctx.log.event(SUMMARY_EVENT, { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });

    return clampSummary(result.text);
};

/** Scheduled by `afterRun`; see the module comment. Never throws: a failed summary changes nothing. */
export const runThreadSummary = internalAction
    .input({ afterMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const job = await ctx.runMutation(internal.agent.thread_summaries.prepareThreadSummary, args);

        if (!job) {
            return null;
        }

        const done = {
            coveredCount: job.coveredCount,
            coveredUpToMessageId: job.coveredUpToMessageId,
            cutClaimedAt: job.cutClaimedAt,
            epoch: job.epoch,
            foldClaimedAt: job.foldClaimedAt,
            taintedBy: job.taintedBy,
            threadId: args.threadId,
        };

        // Rows with no text of their own: the cover moves on and the summary stays (empty for a first cut, so the next
        // job starts after these rows instead of picking the same cut again).
        if (job.transcript === "") {
            await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, {
                ...done,
                ...(job.previousSummaryId && { previousSummaryId: job.previousSummaryId }),
                summary: job.previousSummary ?? "",
            });

            return null;
        }

        let summary: string;

        try {
            summary = await summariseTranscript(ctx, {
                previous: job.previousSummary,
                threadId: args.threadId,
                transcript: job.transcript,
                userId: job.userId,
            });
        } catch (error) {
            console.warn("[agent/thread-summaries] The model call failed; the cut is released:", error);
            await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, done);

            return null;
        }

        await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, {
            ...done,
            ...(job.previousSummaryId && { previousSummaryId: job.previousSummaryId }),
            // An empty answer is still an answer: the cover moves on with the summary it had, rather than paying for
            // the same rows again on every later job.
            summary: summary === "" ? (job.previousSummary ?? "") : summary,
        });

        return null;
    });

/**
 * What the agent reads for older turns when answering `promptMessageId` (or the thread's latest row for a prompt
 * not saved yet): the newest summary whose last covered row is an ancestor of that row. `null` is today's
 * behaviour — no summary, the thread may not be summarised (locked, temporary), an idle summary whose owner opted
 * out, or a summary that belongs to another branch.
 *
 * A compaction also carries its `boundary`: the context builder drops every row up to it from what the model is
 * sent, so the summary REPLACES those turns instead of sitting beside them. Compactions do not need the idle opt-in.
 */
export const getThreadSummaryForContext = internalQuery
    .input({ promptMessageId: v.optional(v.id("messages")), threadId: v.id("threads") })
    .output(
        v.union(
            v.object({
                boundary: v.optional(v.object({ messageId: v.string(), order: v.number(), stepOrder: v.number() })),
                // A thread that has branched can hold rows of a sibling branch at or below the boundary's order.
                branched: v.boolean(),
                summary: v.string(),
            }),
            v.null(),
        ),
    )
    .query(async ({ args, ctx }) => {
        const summaries = await summariesOf(ctx, args.threadId);

        if (summaries.length === 0) {
            return null;
        }

        const thread = ownedBy(await ctx.db.get("threads", args.threadId));

        // The same rules as making one: a lock stops reading what is already stored, and an opt-out stops idle summaries.
        if (!thread || hardBlockerOf(thread) !== null) {
            return null;
        }

        const optedIn = await summariesOptedIn(ctx, thread);
        const usable = summaries.filter((row) => row.kind === "compact" || optedIn);

        if (usable.length === 0) {
            return null;
        }

        let tip: Row | null;

        if (args.promptMessageId) {
            tip = await getThreadRow(ctx, args.threadId, args.promptMessageId);
        } else if (thread.activeLeafMessageId) {
            tip = await resolveLeafRow(ctx, args.threadId, thread.activeLeafMessageId);
        } else {
            tip = (await ctx.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_DESC], where: { threadId: args.threadId } })) as Row | null;
        }

        if (!tip) {
            return null;
        }

        const onPath = await summariesOnPath(ctx, args.threadId, tip, usable, SUMMARY_READ_REACH_ROWS);
        const [best] = onPath;

        if (!best) {
            return null;
        }

        if (best.summary.kind === "compact") {
            const boundary: CompactionBoundary = { messageId: best.covered._id, order: best.covered.order, stepOrder: best.covered.stepOrder };
            // The turns above the compaction's start stay in the notes while the owner keeps idle summaries on.
            const older = idleSummaryAbove(onPath, best)?.summary.summary;

            return {
                boundary,
                branched: thread.activeLeafMessageId !== undefined,
                summary: older ? `${older}\n\n${best.summary.summary}` : best.summary.summary,
            };
        }

        return best.summary.summary === "" ? null : { branched: thread.activeLeafMessageId !== undefined, summary: best.summary.summary };
    });

/** One thread's stored summaries, for the owner's data export (`gdpr/steps.ts#collectConversations`). Lock does not apply: it is their data. */
export const listThreadSummariesForExport = internalQuery
    .input({ threadId: v.id("threads") })
    .output(
        v.array(
            v.object({
                coveredCount: v.number(),
                coveredUpToMessageId: v.string(),
                createdAt: v.number(),
                // A compaction replaces the turns it covers in the model's context; an idle summary sits beside them.
                kind: v.optional(v.literal("compact")),
                summary: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const stored = await summariesOf(ctx, args.threadId);

        return stored
            .toSorted((a, b) => a.coveredCount - b.coveredCount)
            .map((row) => {
                return {
                    coveredCount: row.coveredCount,
                    coveredUpToMessageId: row.coveredUpToMessageId as string,
                    createdAt: row.createdAt,
                    ...(row.kind !== undefined && { kind: row.kind }),
                    summary: row.summary,
                };
            });
    });

/**
 * A reply was edited in place, from `editedOrder` on. Moves the epoch, so a run already under way refuses to
 * store what it read, and erases the summaries that may quote the old text: those covering a row at or after
 * the edit (a summary ending above it never saw it), and any whose covered row is gone.
 */
export const dropSummariesFromEdit = async (ctx: MutationCtx, threadId: Id<"threads">, editedOrder: number): Promise<void> => {
    const thread = await ctx.db.get("threads", threadId);

    if (thread) {
        await ctx.db.patch("threads", threadId, { summaryEpoch: (thread.summaryEpoch ?? 0) + 1 });
    }

    const stored = await summariesOf(ctx, threadId);

    for (const summary of stored) {
        const covered = await getThreadRow(ctx, threadId, summary.coveredUpToMessageId);

        if (!covered || covered.order >= editedOrder) {
            await eraseSummaryRow(ctx, summary);
        }
    }
};

/**
 * Erases the summaries of every thread of `userId` (they live on the user's own shard): the user switched the
 * setting off, which is a promise that what it made goes. Only rows made up to `before`, the moment of that
 * opt-out: a user who switches it back on while batches are still pending keeps the summaries made since.
 * One batch per call; a full batch schedules the next. Returns whether it did.
 */
export const eraseUserThreadSummaries = internalMutation
    .input({ batch: v.optional(v.number()), before: v.number(), userId: v.string().max(MAX_LENGTH.id) })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        const batch = args.batch ?? ERASE_BATCH;
        const { page: rows } = await ctx.db.threadContextSummaries.findMany({
            limit: batch,
            // Compactions stay: the owner asked for them, and they do not depend on this setting.
            where: { createdAt: { lte: args.before }, kind: { isNull: true }, userId: args.userId },
        });

        for (const row of rows) {
            await eraseSummaryRow(ctx, row);
        }

        const more = rows.length === batch;

        if (more) {
            await runAfterOnShard(
                ctx.scheduler,
                0,
                internal.agent.thread_summaries.eraseUserThreadSummaries,
                { batch: args.batch, before: args.before, userId: args.userId },
                args.userId,
            );
        }

        return more;
    });

/** Erases a thread's summaries; the thread is deleted, locked or opted out. Returns whether a full batch went (call again). */
export const deleteThreadSummaries = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, batch = 50): Promise<boolean> => {
    const rows = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(batch);

    for (const row of rows) {
        await eraseSummaryRow(ctx, row);
    }

    return rows.length === batch;
};
