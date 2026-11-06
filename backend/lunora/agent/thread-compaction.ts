/**
 * Context compaction: replaces a thread's older turns, IN WHAT THE MODEL IS SENT, with a summary. The thread's
 * stored messages are never changed or deleted.
 *
 * It reuses the idle-summary machinery (`thread-summaries.ts`) end to end: a compaction is a
 * `threadContextSummaries` row with `kind: "compact"`, so taint, locking, erasure on edit or delete, the data
 * export and the path scoping ("a summary belongs to ONE path") all apply unchanged. What differs:
 *
 * - **It is a boundary.** The context builder (`agent/client/search.ts`) sends the summary as notes AND drops every
 *   row up to the covered one from the recent window. An idle summary only adds notes beside the window.
 * - **It is asked for**, by the owner (`/compact`, the thread menu, the cache-expiry chip) or by the auto-compact
 *   threshold before a reply, so it does not need the idle-summary opt-in and survives its opt-out.
 * - **It folds up to the last {@link COMPACT_KEEP_TURNS} exchanges**, which stay verbatim, however short the
 *   thread is. One summarising call reads a bounded transcript, so a compaction extends its summary over several
 *   calls ({@link COMPACT_MAX_PASSES}) until it reaches the keep point.
 * - **It folds what the model is sent.** It extends only a compaction (never an idle summary) that the reader still
 *   reaches; without one it starts at the first row of the recent window, so its cover always lands where it is read,
 *   or right after the idle summary the reader sends, which is then read beside it and keeps the turns above.
 *
 * ## Flow ({@link compactThreadContext})
 *
 * `prepareThreadCompaction` (one mutation) checks the thread, finds the summary already on this path, plans the
 * cut and claims it (`claimCut`: the cut, and the thread's one summarising call in flight); `summariseTranscript`
 * makes ONE metered utility-model call; `finishThreadSummary` stores the row, replacing the one it extends. The claims
 * make a redelivery, a double click or an idle summary planning another cut of the same rows refuse before paying for a
 * call; the cut's is released when the call fails, the thread's when the call is over.
 *
 * ## Estimating the context ({@link estimateContext})
 *
 * The thread meter sums every step's usage, which is not the size of the next request. The estimate is the larger
 * of the stored text of the rows the model would be sent (plus the summary) and the last step's reported prompt and
 * completion tokens since the boundary.
 */
import { estimateTokensFromCharacters } from "@neore/ai/models";
import { type Infer, v } from "lunorash/server";

import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import { type ActionCtx, internalMutation, type QueryCtx } from "../_generated/server";
import { MAX_LENGTH } from "../lib/validators";
import { isLocalBrowserModel, loadCustomProviders } from "../chat/lib/local-turn";
import { getThreadRow, walkPath } from "./branch-rows";
import { hasLiveDeltaStream } from "./thread-streaming";
import { filterOutOrphanedToolMessages } from "./client/search";
import { replyWindowRows, rowCharacters } from "./handoff-source";
import { AUTO_COMPACT_MAX_PASSES, COMPACT_MAX_PASSES, compactionFoldCount, compactThresholdTokens } from "./thread-compaction-logic";
import {
    claimCut,
    foldedTaint,
    hardBlockerOf,
    idleSummaryAbove,
    leafOf,
    ownedBy,
    type OwnedThread,
    preparedValidator,
    STORAGE_ORDER_DESC,
    summariesOf,
    summariesOnPath,
    summariesOptedIn,
    summariseTranscript,
} from "./thread-summaries";
import { renderTranscript, SUMMARY_MAX_PATH_ROWS, SUMMARY_READ_REACH_ROWS, SUMMARY_RECENT_ROWS } from "./thread-summary-logic";
import { mergeTaint } from "../devices/lib/taint";

type Reader = Pick<QueryCtx, "db">;
type Row = Doc<"messages">;

/** Why a compaction did not (or could not) run. */
export const vCompactionSkip = v.union(
    v.literal("busy"),
    v.literal("failed"),
    v.literal("nothing"),
    v.literal("not_owner"),
    v.literal("too_long"),
    v.literal("unavailable"),
    v.literal("within_threshold"),
);

export type CompactionSkip = Infer<typeof vCompactionSkip>;

/** Rows of the path looked at for the last step's reported usage. */
const USAGE_LOOKBACK_ROWS = 40;

/**
 * Tokens the next request on the path ending at `tip` would carry, and when the compaction it reads from was made: the summary standing in for the older turns plus
 * the rows after the boundary (at most the recent window), as the larger of a text estimate and the last reported
 * usage. A tool-heavy thread's text undercounts, which is what the usage figure covers.
 */
export const estimateContext = async (
    ctx: Reader,
    thread: OwnedThread,
    tip: Row,
): Promise<{
    compactedAt?: number;
    /** The last row the compaction covers, when one stands: the rows after it are what the request carries. */
    covered?: { order: number; stepOrder: number };
    /** The request's text, summaries and media estimate, without the provider's reported usage (which counts the system prompt and tools). */
    textTokens: number;
    tokens: number;
}> => {
    const optedIn = await summariesOptedIn(ctx, thread);
    const summaries = await summariesOf(ctx, thread._id);
    const usable = summaries.filter((row) => row.kind === "compact" || optedIn);
    const onPath = await summariesOnPath(ctx, thread._id, tip, usable, SUMMARY_READ_REACH_ROWS);
    const [best] = onPath;
    const stopAtId = best?.summary.kind === "compact" ? (best.covered._id as string) : undefined;
    // The reader sends an idle summary above a compaction beside it (`idleSummaryAbove`).
    const older = best?.summary.kind === "compact" ? idleSummaryAbove(onPath, best) : undefined;
    const summaryTokens = estimateTokensFromCharacters((best?.summary.summary.length ?? 0) + (older?.summary.summary.length ?? 0));
    // The rows as the reply reads them: successful ones only (a failed or unfinished row is not sent), and without a tool
    // result whose call fell out of the window, which the reply drops as orphaned.
    const window = await replyWindowRows(ctx, thread._id, tip, SUMMARY_RECENT_ROWS, stopAtId);
    const sent = filterOutOrphanedToolMessages(window as Parameters<typeof filterOutOrphanedToolMessages>[0]) as Row[];
    const textTokens = estimateTokensFromCharacters(sent.reduce((total, row) => total + rowCharacters(row), 0));

    const { rows } = await walkPath(ctx, thread._id, tip, { limit: USAGE_LOOKBACK_ROWS, ...(stopAtId && { stopAtId }) });
    const compactedAt = best?.summary.kind === "compact" ? best.summary.createdAt : undefined;
    const textOnly = summaryTokens + textTokens;

    return {
        ...(compactedAt !== undefined && { compactedAt }),
        ...(best?.summary.kind === "compact" && { covered: { order: best.covered.order, stepOrder: best.covered.stepOrder } }),
        textTokens: textOnly,
        tokens: Math.max(textOnly, reportedUsageTokens(rows, compactedAt)),
    };
};

/**
 * What the newest row that reports usage says the request was (prompt plus completion tokens), plus the rows after
 * it (text and a fixed estimate per image or file). `rows` is newest first. 0 when no row reports any, or when that
 * row was written before `compactedAt`: its usage is the size of the request BEFORE the compaction, not after it.
 */
export const reportedUsageTokens = (rows: ReadonlyArray<Row>, compactedAt?: number): number => {
    const reported = rows.findIndex((row) => (row.usage?.promptTokens ?? row.usage?.totalTokens) !== undefined);
    const reportedRow = rows[reported];
    const usage = reportedRow?.usage;

    if (!reportedRow || !usage || (compactedAt !== undefined && reportedRow._creationTime <= compactedAt)) {
        return 0;
    }

    // Only the finished rows the reply sends: a failed or unfinished row is not in the request (as `pathTokens` counts them).
    let newer = 0;

    for (const row of rows.slice(0, reported)) {
        if (row.status === "success") {
            newer += rowCharacters(row);
        }
    }

    const reportedTokens = usage.promptTokens === undefined ? (usage.totalTokens ?? 0) : usage.promptTokens + (usage.completionTokens ?? 0);

    return reportedTokens + estimateTokensFromCharacters(newer);
};

/**
 * Everything one compaction pass needs, or why there is nothing to do. Claims the cut, so a second delivery or a
 * double click gets `busy`. `anchorMessageId` names the prompt a reply is about to answer (auto-compact, inside
 * that reply's run): the path is read up to it and a running stream is expected. Without it the path ends at the
 * thread's leaf and a running stream refuses. `minTokens` makes the pass a no-op below that estimate.
 */
export const prepareThreadCompaction = internalMutation
    .input({
        anchorMessageId: v.optional(v.id("messages")),
        minTokens: v.optional(v.number()),
        threadId: v.id("threads"),
        userId: v.string().max(MAX_LENGTH.id),
    })
    .output(v.object({ job: v.optional(preparedValidator), reason: v.optional(vCompactionSkip) }))
    .mutation(async ({ args, ctx }) => {
        const thread = ownedBy(await ctx.db.get("threads", args.threadId));

        if (!thread || hardBlockerOf(thread) !== null) {
            return { reason: "unavailable" as const };
        }

        // The compaction becomes what later runs read as the thread's history, so only the owner makes one.
        if (thread.userId !== args.userId) {
            return { reason: "not_owner" as const };
        }

        // A chat on the user's own browser-run endpoint keeps its history there: nothing here may send it to a hosted model.
        if (isLocalBrowserModel(thread.model, await loadCustomProviders(ctx, thread.userId))) {
            return { reason: "unavailable" as const };
        }

        // An edit's reply streams through the delta stream, not `persistentStreams`: both count as a reply in progress.
        if (
            !args.anchorMessageId &&
            ((await ctx.db.persistentStreams.findFirst({
                where: { expiresAt: { gt: ctx.now }, status: { in: ["pending", "streaming"] }, threadId: thread._id },
            })) ||
                (await hasLiveDeltaStream(ctx, thread._id)))
        ) {
            return { reason: "busy" as const };
        }

        const latest = thread.activeLeafMessageId
            ? null
            : ((await ctx.db.messages.findFirst({ orderBy: [...STORAGE_ORDER_DESC], where: { threadId: thread._id } })) as Row | null);
        const tip = args.anchorMessageId ? await getThreadRow(ctx, thread._id, args.anchorMessageId) : await leafOf(ctx, thread, latest);

        if (!tip) {
            return { reason: "nothing" as const };
        }

        if (args.minTokens !== undefined) {
            const { tokens } = await estimateContext(ctx, thread, tip);

            if (tokens < args.minTokens) {
                return { reason: "within_threshold" as const };
            }
        }

        // Only a compaction the reader still reaches is extended. An idle summary's text must not land in a row that
        // outlives the idle-summary opt-out, and a cover beyond the read reach is not sent to the model anyway.
        const summaries = await summariesOf(ctx, thread._id);
        const compactions = summaries.filter((row) => row.kind === "compact");
        const [base] = await summariesOnPath(ctx, thread._id, tip, compactions, SUMMARY_READ_REACH_ROWS);
        // Without one, an idle summary the reader sends (opted in, within reach) keeps standing in for the turns it
        // covers: the reader sends it beside the compaction, so the fold starts right after it.
        const [idle] =
            base || !(await summariesOptedIn(ctx, thread))
                ? []
                : await summariesOnPath(
                      ctx,
                      thread._id,
                      tip,
                      summaries.filter((row) => row.kind !== "compact"),
                      SUMMARY_READ_REACH_ROWS,
                  );
        // Without a compaction to extend, the walk reads only the reader's reach: the fold below starts at the window and
        // never needs the rest of a long path, and reading it on every reply (then refusing) cost the reply and the chip.
        const { next, rows } = await walkPath(ctx, thread._id, tip, {
            limit: base ? SUMMARY_MAX_PATH_ROWS : SUMMARY_READ_REACH_ROWS,
            ...(base && { stopAtId: base.covered._id as string, stopBelowOrder: base.covered.order }),
        });

        // Only an extension can reach too far: a cover at the top of a long path is not read, so it is refused.
        if (base && rows.length >= SUMMARY_MAX_PATH_ROWS) {
            return { reason: "too_long" as const };
        }

        // The walk did not reach the previous cover.
        if (base && next?._id !== base.covered._id) {
            return { reason: "nothing" as const };
        }

        // The window shows the last SUMMARY_RECENT_ROWS successful rows (`fetchRecentAndSearchMessages`), so the cut
        // counts those. Without a compaction to extend, the fold starts where that window does (the rows above it are
        // not sent, and a cover folded from the top of a long path could end beyond the read reach, unread), or after
        // the idle summary's cover when that lies further down.
        const successful = rows.toReversed().filter((row) => row.status === "success");
        const afterIdle = idle ? successful.findIndex((row) => row._id === idle.covered._id) + 1 : 0;
        const skipped = base ? 0 : Math.max(0, successful.length - SUMMARY_RECENT_ROWS, afterIdle);
        const after = successful.slice(skipped);
        // An auto-compact anchors on the prompt it answers, which has no reply yet: the verbatim exchanges are the ones
        // before it, as a manual compaction's are the last ones up to the leaf. The prompt is the last row, so leaving it
        // out of the count does not move the indexes of the rows before it.
        const fold = compactionFoldCount(
            after
                .filter((row) => !args.anchorMessageId || row._id !== tip._id)
                .map((row) => {
                    return { order: row.order, role: rowRole(row) };
                }),
        );

        if (fold === 0) {
            return { reason: "nothing" as const };
        }

        const slice = after.slice(0, fold);
        const transcriptRows = slice.map((row) => {
            return { role: rowRole(row), text: transcriptTextOf(row) };
        });
        let { consumed, text } = renderTranscript(transcriptRows);

        // A cut between a tool call and its result would cover the call and leave the result to be dropped as orphaned:
        // the boundary steps back until the next uncovered row is not a result.
        while (consumed > 0 && rowRole(slice[consumed] ?? {}) === "tool") {
            consumed -= 1;
        }

        if (consumed !== transcriptRows.length) {
            text = renderTranscript(transcriptRows.slice(0, consumed)).text;
        }

        const covered = slice[consumed - 1];

        // Without a previous summary, a fold with no text would store an empty summary and drop the rows from the model's
        // context with nothing in their place, so it does not move the boundary.
        if (!covered || (text === "" && !base)) {
            return { reason: "nothing" as const };
        }

        const foldClaimedAt = await claimCut(ctx, thread._id, covered._id, thread.userId);

        if (foldClaimedAt === null) {
            return { reason: "busy" as const };
        }

        return {
            job: {
                // Absolute, as an idle summary's is: the reader ranks the summaries on a path by it.
                coveredCount: (base?.summary.coveredCount ?? skipped) + consumed,
                coveredUpToMessageId: covered._id,
                epoch: thread.summaryEpoch ?? 0,
                foldClaimedAt,
                ...(base && { previousSummary: base.summary.summary, previousSummaryId: base.summary._id }),
                // Whatever untrusted content the folded rows held, and the previous summary already carried.
                taintedBy: mergeTaint(
                    foldedTaint(slice.slice(0, consumed).map((row) => row.message as { content?: unknown; role?: unknown })),
                    base?.summary.taintedBy,
                ),
                transcript: text,
                userId: thread.userId,
            },
        };
    });

export interface CompactionOutcome {
    /** Whether the context changed: at least one pass stored a compaction. */
    compacted: boolean;
    /** Why it stopped short; absent when it reached the keep point. */
    reason?: CompactionSkip;
}

type PreparedJob = Infer<typeof preparedValidator>;

/**
 * Folds ONE prepared cut into the stored summary: a model call, then the row. `true` = stored (or the cut had no
 * text and only the boundary moved); `false` = the cut was released with nothing stored.
 */
const foldJob = async (
    ctx: ActionCtx,
    args: { beforeFirstCall?: () => Promise<void>; signal?: AbortSignal; threadId: Id<"threads"> },
    job: PreparedJob,
): Promise<boolean> => {
    const stored = {
        coveredCount: job.coveredCount,
        coveredUpToMessageId: job.coveredUpToMessageId,
        epoch: job.epoch,
        foldClaimedAt: job.foldClaimedAt,
        kind: "compact" as const,
        ...(job.previousSummaryId && { previousSummaryId: job.previousSummaryId }),
        taintedBy: job.taintedBy,
        threadId: args.threadId,
    };

    // Rows with no text of their own: the boundary moves on and the summary stays.
    // Refused like any other write when the thread changed meanwhile: the loop then reports `failed`, not a compaction.
    if (job.transcript === "") {
        return await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, { ...stored, summary: job.previousSummary ?? "" });
    }

    // With no summary the mutation stores nothing and releases the cut and the thread's fold claim.
    const release = async () => {
        await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, stored);
    };

    // The charge runs once the utility model is resolved, right before the call; a refusal (a limit) is kept apart from a
    // failed call, so it reaches the caller while a failed call only releases the cut.
    let refusal: unknown;
    // Every pass is a model call of its own, so each one is charged, not only the first.
    const beforeCall = async () => {
        try {
            await args.beforeFirstCall?.();
        } catch (error) {
            refusal = error;

            throw error;
        }
    };

    let summary: string;

    try {
        summary = await summariseTranscript(ctx, {
            beforeCall,
            previous: job.previousSummary,
            signal: args.signal,
            threadId: args.threadId,
            transcript: job.transcript,
            userId: job.userId,
        });
    } catch (error) {
        // The cut is free again for the next try, whatever the reason.
        await release();

        if (error === refusal) {
            throw error;
        }

        console.warn("[agent/thread-compaction] The model call failed; the cut is released:", error);

        return false;
    }

    // An empty answer would drop the turns without anything to stand in for them. A reply that was stopped or replaced
    // while the call ran has no use for the summary, so it is not stored either.
    if (summary === "" || args.signal?.aborted) {
        await release();

        return false;
    }

    // Refused when the thread changed meanwhile (an edit, a lock); the mutation released the claim itself.
    return await ctx.runMutation(internal.agent.thread_summaries.finishThreadSummary, { ...stored, summary });
};

/** The role a stored row was written with; an assistant row when the message names none. */
const rowRole = (row: { message?: unknown }): string => (row.message as { role?: string } | undefined)?.role ?? "assistant";

/** A tool output's value as text. Media is named, never encoded: a base64 part would crowd the text after it out of the row. */
const outputText = (output: { type?: unknown; value?: unknown } | undefined): string => {
    if (output?.type !== "content" || !Array.isArray(output.value)) {
        return JSON.stringify(output?.value ?? null);
    }

    return (output.value as ({ text?: unknown; type?: unknown } | null)[])
        .map((item) => {
            if (item?.type === "text" && typeof item.text === "string") {
                return item.text;
            }

            return typeof item?.type === "string" && item.type !== "json" ? `[${item.type}]` : JSON.stringify(item ?? null);
        })
        .join("\n");
};

/** What a tool row returned, as one line per call, for the summariser; `undefined` when the row has no tool results. */
const toolResultsText = (message: unknown): string | undefined => {
    const content = (message as { content?: unknown } | undefined)?.content;

    if (!Array.isArray(content)) {
        return undefined;
    }

    const results = content.flatMap((part: { output?: { type?: unknown; value?: unknown }; toolName?: unknown; type?: unknown }) =>
        part?.type === "tool-result" ? [`${String(part.toolName)}: ${outputText(part.output)}`] : [],
    );

    return results.length > 0 ? `[tool results]\n${results.join("\n")}` : undefined;
};

/** What an assistant row asked its tools for, one line per call, for the summariser; `undefined` when it asked for none. */
const toolCallsText = (message: unknown): string | undefined => {
    const content = (message as { content?: unknown } | undefined)?.content;

    if (!Array.isArray(content)) {
        return undefined;
    }

    const calls = content.flatMap((part: { args?: unknown; input?: unknown; toolName?: unknown; type?: unknown }) =>
        part?.type === "tool-call" ? [`${String(part.toolName)}: ${JSON.stringify(part.input ?? part.args ?? null)}`] : [],
    );

    return calls.length > 0 ? `[tool calls]\n${calls.join("\n")}` : undefined;
};

/**
 * The text the summariser reads for one row: a tool row's results, or an assistant row's text with the calls it made
 * (a call row often has no text at all). `undefined` when there is nothing to read.
 */
export const transcriptTextOf = (row: { message?: unknown; text?: string }): string | undefined => {
    if (rowRole(row) === "tool") {
        return toolResultsText(row.message);
    }

    return [row.text, toolCallsText(row.message)].filter((part): part is string => Boolean(part)).join("\n") || undefined;
};

/**
 * Compacts `threadId`'s model context for its owner `userId`, over up to {@link COMPACT_MAX_PASSES} summarising
 * calls. Never throws for a failed call: it releases the cut and reports `failed`, and whatever earlier passes
 * stored stays (the thread reads from that boundary). `beforeFirstCall` runs before every model
 * call, so a refusal (a daily limit) or a "nothing to compact" costs the caller nothing.
 */
export const compactThreadContext = async (
    ctx: ActionCtx,
    args: {
        anchorMessageId?: Id<"messages">;
        beforeFirstCall?: () => Promise<void>;
        maxPasses?: number;
        minTokens?: number;
        /** Ends the compaction early: a stopped reply, or one a newer run replaced. */
        signal?: AbortSignal;
        threadId: Id<"threads">;
        userId: string;
    },
): Promise<CompactionOutcome> => {
    for (let pass = 0; pass < (args.maxPasses ?? COMPACT_MAX_PASSES); pass += 1) {
        if (args.signal?.aborted) {
            return { compacted: pass > 0, reason: "failed" };
        }

        const { job, reason } = await ctx.runMutation(internal.agent.thread_compaction.prepareThreadCompaction, {
            ...(args.anchorMessageId && { anchorMessageId: args.anchorMessageId }),
            // The size check belongs to the first pass: later ones continue a compaction already under way.
            ...(pass === 0 && args.minTokens !== undefined && { minTokens: args.minTokens }),
            threadId: args.threadId,
            userId: args.userId,
        });

        if (!job) {
            // Reaching the keep point after earlier passes is the normal end, not a skip.
            return pass > 0 ? { compacted: true } : { compacted: false, reason: reason ?? "nothing" };
        }

        let stored: boolean;

        try {
            stored = await foldJob(ctx, args, job);
        } catch (error) {
            // A refusal (the daily limit) before the first call reaches the caller. After earlier passes were stored and
            // charged, the context did change: that is reported, not hidden behind the refusal.
            if (pass === 0) {
                throw error;
            }

            console.warn("[agent/thread-compaction] A later pass was refused; the passes stored so far stand:", error);

            return { compacted: true, reason: "failed" };
        }

        if (!stored) {
            return { compacted: pass > 0, reason: "failed" };
        }
    }

    return { compacted: true };
};

/**
 * Auto-compact: before a reply reads its context, compact it when the estimate (which includes the prompt it is
 * about to answer) fills the user's threshold of `contextWindow`. At most {@link AUTO_COMPACT_MAX_PASSES} calls, and
 * it fails open: a reply is never held up by a compaction that could not run. `anchorMessageId` is the prompt, so
 * the reply's own stream is expected and its turn stays verbatim.
 */
export const autoCompactBeforeReply = async (
    ctx: ActionCtx,
    args: {
        anchorMessageId: Id<"messages">;
        /** Charges the daily quota before the first summarising call; a refusal leaves the reply uncompacted. */
        beforeFirstCall?: () => Promise<void>;
        contextWindow: number;
        signal?: AbortSignal;
        threadId: Id<"threads">;
        thresholdPercent: number | undefined;
        userId: string;
    },
    /** Whether this call compacted the context, so the caller can size anything it chose from the old one again. */
): Promise<boolean> => {
    const minTokens = compactThresholdTokens(args.contextWindow, args.thresholdPercent);

    if (minTokens === undefined) {
        return false;
    }

    try {
        const outcome = await compactThreadContext(ctx, {
            anchorMessageId: args.anchorMessageId,
            beforeFirstCall: args.beforeFirstCall,
            maxPasses: AUTO_COMPACT_MAX_PASSES,
            minTokens,
            signal: args.signal,
            threadId: args.threadId,
            userId: args.userId,
        });

        if (outcome.compacted) {
            ctx.log.event("chat.auto_compact", { userId: args.userId });
        }

        return outcome.compacted;
    } catch (error) {
        console.warn("[agent/thread-compaction] Auto-compact failed; the reply continues with the full context:", error);

        return false;
    }
};
