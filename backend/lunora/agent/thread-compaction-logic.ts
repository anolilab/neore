/**
 * Context compaction — the decisions, kept pure so they are tested without a database. The I/O is in
 * `thread-compaction.ts`; the summary machinery it builds on is `thread-summaries.ts`.
 *
 * A compaction is a stored summary (`threadContextSummaries`, `kind: "compact"`) with a BOUNDARY: the row it
 * covers up to. The context builder (`agent/client/search.ts`) sends the summary as notes and drops every row at or
 * before the boundary from what the model reads. The thread's own rows are never changed or deleted.
 */

/** Exchanges (`order`s) at the end of the path that stay verbatim; everything before them is folded. */
export const COMPACT_KEEP_TURNS = 2;

/** Summarising calls an auto-compact may spend inside a reply's run; a manual `/compact` may use {@link COMPACT_MAX_PASSES}. */
export const AUTO_COMPACT_MAX_PASSES = 2;

/** At least this many rows must be foldable, or a compaction would pay a model call for nothing. */
export const COMPACT_MIN_FOLD_ROWS = 2;

/**
 * One summarising call reads at most `SUMMARY_TRANSCRIPT_CHARS`, so a compaction extends its summary over several
 * calls. The window holds 100 rows of at most `SUMMARY_ROW_CHARS`, so this many calls reach the keep point.
 */
export const COMPACT_MAX_PASSES = 5;

/**
 * The claim on one cut (a thread and the row it covers up to), shared by an idle summary and a compaction: whichever
 * claims the cut first makes the one model call for it, so the other is refused before it spends one.
 */
export const THREAD_CUT_CLAIM_SCOPE = "thread-cut";

/**
 * The claim on a thread's one summarising call in flight, taken with the cut's: two runs that plan different cuts of the
 * same rows (an idle summary and a compaction, or two compactions anchored on different rows) would otherwise both pay,
 * and one of them would then be refused when it stores. Released when the call is over (`finishThreadSummary`).
 */
export const THREAD_FOLD_CLAIM_SCOPE = "thread-fold";

/** Outlasts the summarising call's one-minute deadline and the charge before it; a run that died frees the thread after it. */
export const THREAD_FOLD_CLAIM_TTL_MS = 3 * 60 * 1000;

/** Auto-compact: the lowest and highest threshold the setting accepts, in percent of the model's context window. */
export const AUTO_COMPACT_MIN_PERCENT = 50;
export const AUTO_COMPACT_MAX_PERCENT = 95;

export interface CompactionBoundary {
    messageId: string;
    order: number;
    stepOrder: number;
}

/**
 * How many of `rows` (successful rows of the path after the previous cover, oldest first, without an unanswered
 * prompt the reply is about to answer) one compaction folds: every row before the last {@link COMPACT_KEEP_TURNS}
 * exchanges. An exchange starts at a user row of an `order` not seen before; the rows after it (the reply, its tool
 * rows, a continuation under a later `order`) belong to it. The keep point is counted from the rows themselves, not
 * from `order` arithmetic: a path's orders have gaps (a continuation takes an order past every row, a sibling branch
 * holds others). Cutting right before a user row never splits a tool call from its result. `0` = nothing worth folding.
 */
export const compactionFoldCount = (rows: ReadonlyArray<{ order: number; role: string }>): number => {
    const starts: number[] = [];
    const seen = new Set<number>();

    for (const [index, row] of rows.entries()) {
        if (row.role !== "user" || seen.has(row.order)) {
            continue;
        }

        seen.add(row.order);
        starts.push(index);
    }

    const count = starts.length >= COMPACT_KEEP_TURNS ? (starts[starts.length - COMPACT_KEEP_TURNS] ?? 0) : 0;

    return count >= COMPACT_MIN_FOLD_ROWS ? count : 0;
};

/**
 * `rows` (a path-ordered context window, oldest first) without what a compaction covers: everything up to and
 * including the boundary row. The row is found by id; when the window no longer holds it (it was dropped as an
 * orphaned tool message) the boundary's storage position decides.
 */
export const dropCompactedRows = <R extends { _id: string; order: number; stepOrder: number }>(rows: ReadonlyArray<R>, boundary: CompactionBoundary): R[] => {
    const at = rows.findIndex((row) => row._id === boundary.messageId);

    if (at !== -1) {
        return rows.slice(at + 1);
    }

    return rows.filter((row) => row.order > boundary.order || (row.order === boundary.order && row.stepOrder > boundary.stepOrder));
};

/**
 * Tokens at which auto-compact acts for a model with `contextWindow` tokens: `thresholdPercent` of it. `undefined`
 * for off (absent, 0, or below the setting's range) or a window that is unknown.
 */
export const compactThresholdTokens = (contextWindow: number, thresholdPercent: number | undefined): number | undefined => {
    if (!thresholdPercent || thresholdPercent < AUTO_COMPACT_MIN_PERCENT || contextWindow <= 0) {
        return undefined;
    }

    return Math.floor((contextWindow * Math.min(thresholdPercent, AUTO_COMPACT_MAX_PERCENT)) / 100);
};
