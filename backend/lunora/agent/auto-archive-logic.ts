/**
 * Auto-archive's pure half: which settings value is allowed, and which threads a
 * sweep may archive now. I/O lives in `auto-archive.ts`; pinned by
 * `auto-archive-logic.test.ts`.
 */

import type { ScanPage } from "../lib/scan-pages";

const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTO_ARCHIVE_MIN_DAYS = 7;
export const AUTO_ARCHIVE_MAX_DAYS = 365;

/** Off is `0` or absent; otherwise a whole number of days in range. */
export const isAutoArchiveDays = (value: number | undefined): value is number =>
    value !== undefined && (value === 0 || (Number.isSafeInteger(value) && value >= AUTO_ARCHIVE_MIN_DAYS && value <= AUTO_ARCHIVE_MAX_DAYS));

/** The `updatedAt` below which a thread counts as idle. `updatedAt` moves on every activity and on archive itself. */
export const autoArchiveCutoff = (now: number, days: number): number => now - days * DAY_MS;

export interface AutoArchiveCandidate {
    _id: string;
    deleted?: boolean;
    isTemporary?: boolean;
    pinnedAt?: number;
    projectId?: string;
    status: string;
    updatedAt?: number;
}

export interface AutoArchiveExclusions {
    /** Threads with a run in flight (a pending or streaming persistent stream). */
    liveThreadIds: ReadonlySet<string>;
    /** Projects the user pinned: their threads stay put. */
    pinnedProjectIds: ReadonlySet<string>;
}

/**
 * The threads one sweep may archive, in the order given, at most `limit`. Never
 * archived: already archived, running, deleted, temporary (they expire on
 * their own), pinned, in a pinned project, or with a live stream. A thread
 * with no `updatedAt` is not idle by definition, so it stays.
 */
export const selectAutoArchiveDue = (
    candidates: ReadonlyArray<AutoArchiveCandidate>,
    cutoff: number,
    exclusions: AutoArchiveExclusions,
    limit: number,
): string[] =>
    candidates
        .filter(
            (thread) =>
                thread.status !== "archived" &&
                thread.status !== "running" &&
                thread.deleted !== true &&
                thread.isTemporary !== true &&
                thread.pinnedAt === undefined &&
                (thread.projectId === undefined || !exclusions.pinnedProjectIds.has(thread.projectId)) &&
                !exclusions.liveThreadIds.has(thread._id) &&
                thread.updatedAt !== undefined &&
                thread.updatedAt < cutoff,
        )
        .slice(0, limit)
        .map((thread) => thread._id);

export interface ArchivePassInput {
    archiveBatch: number;
    /** Re-reads the row and archives it only if it is still due. True when it was archived. */
    archiveIfStillDue: (threadId: string) => Promise<boolean>;
    cursor: string | null;
    /** The next index page after `cursor`, newest-idle first. */
    fetchPage: (cursor: string | null) => Promise<ScanPage<AutoArchiveCandidate>>;
    /** Snapshot check on the row as read; a cheap filter before the write. */
    isDue: (candidate: AutoArchiveCandidate) => boolean;
    /** Rows read per pass. Past it, the pass returns a cursor so the next run resumes where this one stopped. */
    readBudget: number;
}

export interface ArchivePassResult {
    archived: number;
    /** Set when the read budget ran out before the range did; resume from here. */
    continueCursor: string | null;
}

/**
 * Walks the idle range newest-first, past rows that are not due (archived, pinned,
 * running, and so on), until `archiveBatch` threads are archived, the range ends,
 * or `readBudget` rows have been read. Unlike a single fixed-size scan, ineligible
 * rows cannot hide the eligible ones behind them: the walk keeps going until the
 * budget, and a returned cursor continues it on the next run.
 */
export const runArchivePass = async (input: ArchivePassInput): Promise<ArchivePassResult> => {
    let { cursor } = input;
    let read = 0;
    let archived = 0;

    for (;;) {
        const result = await input.fetchPage(cursor);

        read += result.page.length;

        for (const candidate of result.page) {
            if (!input.isDue(candidate) || !(await input.archiveIfStillDue(candidate._id))) {
                continue;
            }

            archived += 1;

            if (archived >= input.archiveBatch) {
                return { archived, continueCursor: null };
            }
        }

        if (result.isDone || !result.continueCursor) {
            return { archived, continueCursor: null };
        }

        if (result.continueCursor === cursor) {
            throw new Error("runArchivePass: the continuation cursor did not advance");
        }

        if (read >= input.readBudget) {
            return { archived, continueCursor: result.continueCursor };
        }

        cursor = result.continueCursor;
    }
};
