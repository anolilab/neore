/**
 * The decisions of a pull request watch: what one host read means for a thread that asked to be woken. Pure, so every
 * rule is pinned by a table. No clock, database or host in here: the caller reads the host, passes the observation and
 * the stored watch state, and writes back whatever the decision says.
 *
 * A watch is silent at its first read (its baseline): whatever is already failing, conflicting or reviewed when it
 * starts is recorded, not reported. After that, each occurrence wakes the thread once: a failing head, a conflict on a
 * head, or a newer review by someone other than the watcher. An occurrence seen during a cooldown is kept as pending and
 * delivered once the cooldown has passed. A watch that has reached its wake cap ends on its next read, and the caller
 * stops it.
 */

export const PR_WATCH_MAX_WAKES = 5;
export const PR_WATCH_WAKE_COOLDOWN_MS = 10 * 60 * 1000;

export type WatchWakeReason = "checks" | "conflict" | "review";

/** What the watch keeps between reads. Every key is optional: an absent key means nothing was seen yet. */
export interface PullRequestWatchState {
    /** Set once the watch has taken its baseline read. */
    baselined?: boolean;
    /** The head whose failing checks were already seen (and reported, or kept pending). */
    checksHeadSha?: string;
    /** The head whose conflict was already seen (and reported, or kept pending). */
    conflictHeadSha?: string;
    /** The newest head read; absent until the baseline read. */
    headSha?: string;
    /** When the last wake was sent. Absent: none sent in this watch yet. */
    lastWakeAt?: number;
    /** Occurrences seen during a cooldown, delivered once it has passed. */
    pending?: WatchWakeReason[];
    /** The newest review by someone other than the watcher that the watch has seen, by id. */
    reviewId?: string;
    /** Wakes sent so far, across restarts of the watch: a restart does not reset the cap. */
    wakes?: number;
}

export interface PullRequestObservation {
    /** Whether every required check has finished (`pending` while any is still running). */
    checks: "failing" | "passing" | "pending";
    /** Names of the failing checks, for the wake's summary. Only text the host sent: untrusted. */
    failingCheckNames: ReadonlyArray<string>;
    /** The head commit now. */
    headSha: string;
    /** Whether the host can merge the head. `unknown` while the host has not computed it. */
    mergeable: "clean" | "conflicting" | "unknown";
    /** Every submitted review, newest first, as the host lists them now. */
    reviews: ReadonlyArray<{ authorLogin: string; id: string }>;
    /**
     * True when the host holds more reviews than were listed and the list does not reach the seen review: every listed review is
     * then newer than the seen one, which the decision cannot find by position.
     */
    reviewsTruncated?: boolean;
    /** The host's state of the pull request now. */
    state: "closed" | "merged" | "open";
    /** The person's own login. Their reviews never wake them. */
    watcherLogin: string;
}

export type WatchDecision =
    /** Nothing to do: the watch keeps its state (possibly updated with what was seen). */
    | { action: "none"; state: PullRequestWatchState }
    /** The baseline read: recorded silently, nothing reported. */
    | { action: "baseline"; state: PullRequestWatchState }
    /** The thread is woken once, for every reason owed, and the watch goes on. */
    | { action: "wake"; reasons: WatchWakeReason[]; state: PullRequestWatchState }
    /** The watch is over: the pull request is no longer open, or the wake cap was reached. The caller stops it. */
    | { action: "end"; reason: "closed" | "cap"; state: PullRequestWatchState };

/**
 * Whether the review is the watcher's own. Host logins are not case-sensitive, so the comparison is not either. With no
 * watcher login the review cannot be told from anyone else's.
 */
const isByWatcher = (review: { authorLogin: string }, watcherLogin: string): boolean =>
    watcherLogin !== "" && review.authorLogin.toLowerCase() === watcherLogin.toLowerCase();

/**
 * The reviews by someone other than the watcher are only known when the watcher is. A missing login (empty) leaves review
 * handling out altogether: guessing would wake the person for their own review, or record one of theirs as the one seen.
 */
const reviewsByOthers = (observed: PullRequestObservation): { authorLogin: string; id: string }[] =>
    observed.watcherLogin.trim() === "" ? [] : observed.reviews.filter((review) => !isByWatcher(review, observed.watcherLogin.trim()));

/**
 * The review a read leaves as the watch's marker: the newest by someone other than the watcher. With no login the watcher's
 * reviews cannot be told apart, so the newest review of all marks the place: every review at or before it is old, and a later
 * read that has the login alerts only on reviews newer than it.
 */
const newestReviewByOthers = (observed: PullRequestObservation): { authorLogin: string; id: string } | undefined =>
    observed.watcherLogin.trim() === "" ? observed.reviews[0] : reviewsByOthers(observed)[0];

/**
 * The reviews by others that are newer than the one the watch last saw. The host lists reviews newest first, so those are
 * the entries before the seen one. With no seen review, every review by others is new. `left` is true when a seen review
 * is no longer listed at all: nothing can be said about what is new, so the caller re-baselines instead.
 */
const newerReviewsByOthers = (
    observed: PullRequestObservation,
    seenId: string | undefined,
): { left: boolean; newer: { authorLogin: string; id: string }[] } => {
    if (seenId === undefined) {
        return { left: false, newer: reviewsByOthers(observed) };
    }

    if (observed.watcherLogin.trim() === "") {
        return { left: false, newer: [] };
    }

    const at = observed.reviews.findIndex((review) => review.id === seenId);

    if (at === -1) {
        return { left: true, newer: [] };
    }

    return { left: false, newer: observed.reviews.slice(0, at).filter((review) => !isByWatcher(review, observed.watcherLogin.trim())) };
};

/**
 * One host read against a watch. The result's `state` is what the caller stores. An occurrence due during a cooldown is
 * recorded as pending (with the markers it set), so it is still delivered after the cooldown even if the head has moved on.
 */
export const decideWatch = (previous: PullRequestWatchState, observed: PullRequestObservation, now: number): WatchDecision => {
    if (observed.state !== "open") {
        return { action: "end", reason: "closed", state: previous };
    }

    const review = newestReviewByOthers(observed);

    if (previous.baselined !== true) {
        // A restart keeps the count: only the baseline's keys are new.
        return {
            action: "baseline",
            state: {
                baselined: true,
                headSha: observed.headSha,
                ...(observed.checks === "failing" && { checksHeadSha: observed.headSha }),
                ...(observed.mergeable === "conflicting" && { conflictHeadSha: observed.headSha }),
                ...(review !== undefined && { reviewId: review.id }),
                ...(previous.wakes !== undefined && { wakes: previous.wakes }),
            },
        };
    }

    // A capped watch ends on its next read, whatever the read shows: it must not keep occupying a slot.
    if ((previous.wakes ?? 0) >= PR_WATCH_MAX_WAKES) {
        return { action: "end", reason: "cap", state: previous };
    }

    const owed: WatchWakeReason[] = [...(previous.pending ?? [])];
    const next: PullRequestWatchState = { ...previous, headSha: observed.headSha };

    if (observed.checks === "failing" && previous.checksHeadSha !== observed.headSha) {
        next.checksHeadSha = observed.headSha;

        if (!owed.includes("checks")) {
            owed.push("checks");
        }
    }

    if (observed.mergeable === "conflicting" && previous.conflictHeadSha !== observed.headSha) {
        next.conflictHeadSha = observed.headSha;

        if (!owed.includes("conflict")) {
            owed.push("conflict");
        }
    }

    const { left, newer } = newerReviewsByOthers(observed, previous.reviewId);

    if (observed.watcherLogin.trim() === "") {
        // The watcher is unknown: no review wakes and a marker already set does not move. A watch with none yet is marked at the
        // newest review, silently, so the next read that has the login does not take every older review for a new one.
        next.reviewId ??= observed.reviews[0]?.id;
    } else if (left) {
        // The seen review left the host's list (deleted, or older than the pages the read went back through: its bound is the limit
        // of what this can tell). Nothing can be said about what is new, so re-baseline silently on the newest review by someone
        // else, or clear the marker when there is none: the next review by someone else then wakes the thread.
        next.reviewId = review?.id;

        // A truncated list that does not reach the seen review holds only newer ones: a review by someone else is new, not lost.
        if (observed.reviewsTruncated === true && review !== undefined && !owed.includes("review")) {
            owed.push("review");
        }
    } else if (newer.length > 0) {
        next.reviewId = newer[0]?.id;

        if (!owed.includes("review")) {
            owed.push("review");
        }
    }

    if (owed.length === 0) {
        return { action: "none", state: next };
    }

    // Cooldown first: what is owed waits, with its markers recorded, and is delivered on a later read.
    if (previous.lastWakeAt !== undefined && now - previous.lastWakeAt < PR_WATCH_WAKE_COOLDOWN_MS) {
        return { action: "none", state: { ...next, pending: owed } };
    }

    return {
        action: "wake",
        reasons: owed,
        state: { ...next, lastWakeAt: now, pending: undefined, wakes: (previous.wakes ?? 0) + 1 },
    };
};

type StoredWatchBase = Omit<PullRequestWatchState, "pending">;

/** The `watch` object of a `pullRequestThreads` row: the decision's stored keys plus the watch's own lifecycle. */
export type StoredWatch = StoredWatchBase & { startedAt: number; stoppedAt?: number };

const withoutUndefined = <T extends Record<string, unknown>>(value: T): T =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

/** Maps a decision's state to the row's two stored fields: `watch` (no `pending`) and `watchPending`. */
export const storedWatchOf = (state: StoredWatch & { pending?: WatchWakeReason[] }): { watch: StoredWatch; watchPending: WatchWakeReason[] | undefined } => {
    const { pending, ...watch } = state;

    return { watch: withoutUndefined(watch), watchPending: pending };
};

/** Maps a row's stored fields back to the decision's state. */
export const stateOf = (row: { watch?: StoredWatch; watchPending?: WatchWakeReason[] }): PullRequestWatchState => {
    const { baselined, checksHeadSha, conflictHeadSha, headSha, lastWakeAt, reviewId, wakes } = row.watch ?? {};

    return withoutUndefined({ baselined, checksHeadSha, conflictHeadSha, headSha, lastWakeAt, pending: row.watchPending, reviewId, wakes });
};
