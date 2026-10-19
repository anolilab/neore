/**
 * Auto-archive's pure half: which settings value is allowed, and which threads a
 * sweep may archive now. I/O lives in `auto-archive.ts`; pinned by
 * `auto-archive-logic.test.ts`.
 */

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
