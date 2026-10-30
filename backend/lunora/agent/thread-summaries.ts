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
 * ## Reading
 *
 * {@link getThreadSummaryForContext} answers the context builder
 * (`agent/client/search.ts`): the newest summary whose last covered row is an
 * ancestor of the prompt, or nothing. A summary of another branch is never
 * used, and a locked thread has none (the lock paths erase them).
 */
import { generateText } from "ai";
import { v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { internalAction, internalMutation, internalQuery, type MutationCtx, type QueryCtx } from "../_generated/server";
import { claimOnce, releaseClaim } from "../lib/claim-once";
import { gatewayFetch } from "../lib/services";
import { isThreadLocked } from "../lib/thread-lock";
import { getUtilityModel } from "../lib/utility-model";
import { MAX_LENGTH } from "../lib/validators";
import { getThreadRow, resolveLeafRow, walkPath } from "./branch-rows";
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
    THREAD_SUMMARY_CLAIM_SCOPE,
    THREAD_SUMMARY_CLAIM_TTL_MS,
} from "./thread-summary-logic";

type Reader = Pick<QueryCtx, "db">;
type Row = Doc<"messages">;
type Thread = Doc<"threads">;
type OwnedThread = Thread & { userId: string };

const SUMMARY_EVENT = "chat.thread_summary";

const STORAGE_ORDER_DESC = [{ order: "desc" }, { stepOrder: "desc" }, { _creationTime: "desc" }] as const;

const claimKey = (threadId: string, coveredUpToMessageId: string): string => `${threadId}:${coveredUpToMessageId}`;

/** The thread, when it has an owner to bill and attribute the summary to. */
const ownedBy = (thread: Thread | null): OwnedThread | null => (thread?.userId ? (thread as OwnedThread) : null);

/** Why the thread must not be summarised, or `null` when it may. */
const blockerOf = async (ctx: Reader, thread: OwnedThread): Promise<string | null> => {
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

    // Stateless chats keep no history; host-run threads are the coding agent's own.
    if (thread.statelessMode === true || thread.runner === "host") {
        return "unsupported";
    }

    const settings = await ctx.db
        .query("userSettings")
        .withIndex("by_userId", (q) => q.eq("userId", thread.userId))
        .first();

    // Opt-OUT: absent means on.
    return settings?.threadSummariesEnabled === false ? "disabled" : null;
};

/** Of `candidates` (rows of a thread), the ids that are `tip` or among its `reach` nearest ancestors. */
const ancestorIds = async (ctx: Reader, threadId: Id<"threads">, tip: Row, candidates: ReadonlyArray<Row>, reach: number): Promise<Set<string>> => {
    if (candidates.length === 0) {
        return new Set();
    }

    const wanted = new Set(candidates.map((row) => row._id as string));
    const { rows } = await walkPath(ctx, threadId, tip, { limit: reach, stopBelowOrder: Math.min(...candidates.map((row) => row.order)) });

    return new Set(rows.map((row) => row._id as string).filter((id) => wanted.has(id)));
};

const summariesOf = async (ctx: Reader, threadId: Id<"threads">): Promise<Doc<"threadContextSummaries">[]> =>
    await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(SUMMARIES_KEPT_PER_THREAD + 2);

/**
 * The summaries of `threadId` whose last covered row is an ancestor of `tip`
 * within `reach` rows (`tip` itself does not count), each with that row, the one
 * covering the most first. A covered row that is gone (deleted) disqualifies its summary.
 */
const summariesOnPath = async (
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

/** The row the thread's active path ends at. */
const leafOf = async (ctx: Reader, thread: Thread, latest: Row | null): Promise<Row | null> =>
    thread.activeLeafMessageId ? await resolveLeafRow(ctx, thread._id, thread.activeLeafMessageId) : latest;

const preparedValidator = v.object({
    coveredCount: v.number(),
    coveredUpToMessageId: v.id("messages"),
    previousSummary: v.optional(v.string()),
    previousSummaryId: v.optional(v.id("threadContextSummaries")),
    transcript: v.string(),
    userId: v.string(),
});

/**
 * Everything one summarising run needs, or `null` when there is nothing to do
 * now. Claims the cut, so a second delivery of the job gets `null`.
 */
export const prepareThreadSummary = internalMutation
    .input({ afterMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.union(preparedValidator, v.null()))
    .mutation(async ({ args, ctx }) => {
        const thread = ownedBy(await ctx.db.get(args.threadId));

        if (!thread || (await blockerOf(ctx, thread)) !== null) {
            return null;
        }

        // Idle since the reply: the reply's last row is still the thread's latest, and nothing is streaming.
        const latest = (await ctx.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_DESC], where: { threadId: thread._id } })) as Row | null;

        if (!latest || latest._id !== args.afterMessageId) {
            return null;
        }

        if (await ctx.db.persistentStreams.findFirst({ where: { status: { in: ["pending", "streaming"] }, threadId: thread._id } })) {
            return null;
        }

        const leaf = await leafOf(ctx, thread, latest);

        if (!leaf) {
            return null;
        }

        const [base] = await summariesOnPath(ctx, thread._id, leaf, await summariesOf(ctx, thread._id), SUMMARY_MAX_PATH_ROWS);
        const { next, rows } = await walkPath(ctx, thread._id, leaf, {
            limit: SUMMARY_MAX_PATH_ROWS,
            ...(base && { stopAtId: base.covered._id as string }),
        });

        // Too long to read from the top, or the walk did not reach the previous cover: keep today's behaviour.
        if (rows.length >= SUMMARY_MAX_PATH_ROWS || (base && next?._id !== base.covered._id)) {
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
                return { role: (row.message as { role?: string } | undefined)?.role ?? "assistant", text: row.tool ? undefined : row.text };
            }),
        );
        const covered = slice[consumed - 1];

        if (!covered) {
            return null;
        }

        if (!(await claimOnce(ctx, THREAD_SUMMARY_CLAIM_SCOPE, claimKey(thread._id, covered._id), THREAD_SUMMARY_CLAIM_TTL_MS, thread.userId))) {
            return null;
        }

        return {
            coveredCount: (base?.summary.coveredCount ?? 0) + consumed,
            coveredUpToMessageId: covered._id,
            ...(base && { previousSummary: base.summary.summary, previousSummaryId: base.summary._id }),
            transcript: text,
            userId: thread.userId,
        };
    });

/**
 * Stores the summary and drops the one it extends, keeping the newest few of
 * other branches. With no `summary` the run failed and only its claim goes, so
 * the next reply's job can try the same cut again.
 */
export const finishThreadSummary = internalMutation
    .input({
        coveredCount: v.number(),
        coveredUpToMessageId: v.id("messages"),
        previousSummaryId: v.optional(v.id("threadContextSummaries")),
        summary: v.optional(v.string().max(MAX_LENGTH.long)),
        threadId: v.id("threads"),
    })
    .output(v.boolean())
    .mutation(async ({ args, ctx }) => {
        if (args.summary === undefined) {
            await releaseClaim(ctx, THREAD_SUMMARY_CLAIM_SCOPE, claimKey(args.threadId, args.coveredUpToMessageId));

            return false;
        }

        // The model call took a while: the thread may have been locked, deleted or opted out meanwhile.
        const thread = ownedBy(await ctx.db.get(args.threadId));

        if (!thread || (await blockerOf(ctx, thread)) !== null) {
            return false;
        }

        const existing = await summariesOf(ctx, args.threadId);

        // Idempotent on the cut; and refuse to store over a summary that moved since the run was prepared.
        if (existing.some((row) => row.coveredUpToMessageId === args.coveredUpToMessageId)) {
            return false;
        }

        if (args.previousSummaryId && existing.every((row) => row._id !== args.previousSummaryId)) {
            return false;
        }

        await ctx.db.insert("threadContextSummaries", {
            coveredCount: args.coveredCount,
            coveredUpToMessageId: args.coveredUpToMessageId,
            createdAt: ctx.now,
            summary: args.summary,
            threadId: args.threadId,
            userId: thread.userId,
        });

        // The row it extends is replaced; of the other branches' rows the newest few stay.
        const others = existing.filter((row) => row._id !== args.previousSummaryId).toSorted((a, b) => b.createdAt - a.createdAt);
        const stale = [...existing.filter((row) => row._id === args.previousSummaryId), ...others.slice(SUMMARIES_KEPT_PER_THREAD - 1)];

        for (const row of stale) {
            await ctx.db.delete(row._id);
        }

        return true;
    });

/** Scheduled by `afterRun`; see the module comment. Never throws: a failed summary changes nothing. */
export const runThreadSummary = internalAction
    .input({ afterMessageId: v.id("messages"), threadId: v.id("threads") })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const job = await ctx.runMutation(internal.agent.thread_summaries.prepareThreadSummary, args);

        if (!job) {
            return null;
        }

        const done = { coveredCount: job.coveredCount, coveredUpToMessageId: job.coveredUpToMessageId, threadId: args.threadId };

        // Rows with no text of their own: the cover moves on, the summary stays.
        if (job.transcript === "") {
            if (job.previousSummary) {
                await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, {
                    ...done,
                    previousSummaryId: job.previousSummaryId,
                    summary: job.previousSummary,
                });
            } else {
                await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, done);
            }

            return null;
        }

        let summary: string;

        try {
            const result = await generateText({
                maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
                model: await getUtilityModel(gatewayFetch(ctx), { threadId: args.threadId, userId: job.userId }),
                prompt: buildSummaryPrompt(job.previousSummary, job.transcript),
                system: SUMMARY_SYSTEM_PROMPT,
            });

            summary = clampSummary(result.text);
            ctx.log.event(SUMMARY_EVENT, { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens });
        } catch (error) {
            console.warn("[agent/thread-summaries] The model call failed; the cut is released:", error);
            await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, done);

            return null;
        }

        await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, {
            ...done,
            ...(job.previousSummaryId && { previousSummaryId: job.previousSummaryId }),
            ...(summary !== "" && { summary }),
        });

        return null;
    });

/**
 * The summary the agent reads ahead of its recent rows when answering
 * `promptMessageId` (or the thread's latest row for a prompt not saved yet):
 * the newest one whose last covered row is an ancestor of that row. `null` is
 * today's behaviour — no summary, the thread may not be summarised (locked,
 * temporary, opted out), or the summary belongs to another branch.
 */
export const getThreadSummaryForContext = internalQuery
    .input({ promptMessageId: v.optional(v.id("messages")), threadId: v.id("threads") })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args, ctx }) => {
        const summaries = await summariesOf(ctx, args.threadId);

        if (summaries.length === 0) {
            return null;
        }

        const thread = ownedBy(await ctx.db.get(args.threadId));

        // The same rules as making one: an opt-out or a lock stops reading what is already stored.
        if (!thread || (await blockerOf(ctx, thread)) !== null) {
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

        const [best] = await summariesOnPath(ctx, args.threadId, tip, summaries, SUMMARY_READ_REACH_ROWS);

        return best && best.summary.summary !== "" ? best.summary.summary : null;
    });

/** Erases a thread's summaries; the thread is deleted, locked or opted out. Returns whether a full batch went (call again). */
export const deleteThreadSummaries = async (ctx: Pick<MutationCtx, "db">, threadId: Id<"threads">, batch = 50): Promise<boolean> => {
    const rows = await ctx.db
        .query("threadContextSummaries")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .take(batch);

    for (const row of rows) {
        await ctx.db.delete(row._id);
    }

    return rows.length === batch;
};
