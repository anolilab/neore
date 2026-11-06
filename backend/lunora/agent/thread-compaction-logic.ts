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

/** Auto-compact: the lowest and highest threshold the setting accepts, in percent of the model's context window. */
export const AUTO_COMPACT_MIN_PERCENT = 50;
export const AUTO_COMPACT_MAX_PERCENT = 95;

export interface CompactionBoundary {
    messageId: string;
    order: number;
    stepOrder: number;
}

/**
 * How many of `rows` (successful rows of the path after the previous cover, oldest first) one compaction folds:
 * the leading ones whose `order` is below the keep point. `anchorOrder` is the `order` of the row the next reply
 * hangs off (the leaf, or the prompt being answered). A turn's rows share an `order`, so the cut never splits a
 * tool call from its result. `0` = nothing worth folding.
 */
export const compactionFoldCount = (rows: ReadonlyArray<{ order: number }>, anchorOrder: number): number => {
    const keepFromOrder = anchorOrder - COMPACT_KEEP_TURNS + 1;
    let count = 0;

    for (const row of rows) {
        if (row.order >= keepFromOrder) {
            break;
        }

        count += 1;
    }

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
