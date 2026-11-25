/**
 * The decisions of a pull request watch: what one host read means for a thread that asked to be woken. Pure, so every
 * rule is pinned by a table. No clock, database or host in here: the caller reads the host, passes the observation and
 * the stored watch state, and writes back whatever the decision says.
 *
 * A watch is silent at its first read (its baseline): whatever is already failing, conflicting or reviewed when it
 * starts is recorded, not reported. After that, each occurrence wakes the thread once: a failing head, a conflict on a
 * head, or a review the watcher did not write. A wake is spaced by a cooldown and a watch ends after a cap of wakes, so
 * a fix that fails again cannot loop forever.
 */

export const PR_WATCH_MAX_WAKES = 5;
export const PR_WATCH_WAKE_COOLDOWN_MS = 10 * 60 * 1000;

/** What the watch keeps between reads. Every key is optional: an absent key means nothing was seen yet. */
export interface PullRequestWatchState {
    /** Set once the watch has taken its baseline read. */
    baselined?: boolean;
    /** The head whose failing checks already woke the thread (or was recorded at the baseline). */
    checksHeadSha?: string;
    /** The head whose conflict already woke the thread (or was recorded at the baseline). */
    conflictHeadSha?: string;
    /** The newest head read; absent until the baseline read. */
    headSha?: string;
    /** When the last wake was sent. Absent: none sent in this watch yet. */
    lastWakeAt?: number;
    /** The newest review by someone other than the watcher, by id. */
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
    /** Every submitted review, newest first. The watcher's own are skipped here, not in the caller. */
    reviews: ReadonlyArray<{ authorLogin: string; id: string }>;
    /** The host's state of the pull request now. */
    state: "closed" | "merged" | "open";
    /** The person's own login. Their reviews never wake them. */
    watcherLogin: string;
}

export type WakeReason = "checks" | "conflict" | "review";

export type WatchDecision =
    /** Nothing to do: the watch keeps its state (possibly updated with what was seen). */
    | { action: "none"; state: PullRequestWatchState }
    /** The baseline read: recorded silently, nothing reported. */
    | { action: "baseline"; state: PullRequestWatchState }
    /** The thread is woken once, for every reason, and the watch goes on. */
    | { action: "wake"; reasons: WakeReason[]; state: PullRequestWatchState }
    /** The watch is over: the pull request is no longer open, or the wake cap was reached. */
    | { action: "end"; reason: "closed" | "cap"; state: PullRequestWatchState };

/** The newest review by someone other than the watcher: the only review a watch is told about. */
const newestReviewByOthers = (observed: PullRequestObservation): { authorLogin: string; id: string } | undefined =>
    observed.reviews.find((review) => review.authorLogin !== observed.watcherLogin);

/**
 * One host read against a watch. The result's `state` is what the caller stores. When a wake is due but the cooldown
 * has not passed, nothing is recorded, so the same occurrence is wanted again on the next read.
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

    const reasons: WakeReason[] = [];
    const next: PullRequestWatchState = { ...previous, headSha: observed.headSha };

    if (observed.checks === "failing" && observed.failingCheckNames.length > 0 && previous.checksHeadSha !== observed.headSha) {
        reasons.push("checks");
        next.checksHeadSha = observed.headSha;
    }

    if (observed.mergeable === "conflicting" && previous.conflictHeadSha !== observed.headSha) {
        reasons.push("conflict");
        next.conflictHeadSha = observed.headSha;
    }

    if (review !== undefined && review.id !== previous.reviewId) {
        reasons.push("review");
        next.reviewId = review.id;
    }

    if (reasons.length === 0) {
        return { action: "none", state: next };
    }

    // Cooldown first: a wake that waits keeps its occurrence unrecorded, so the next read still wants it.
    if (previous.lastWakeAt !== undefined && now - previous.lastWakeAt < PR_WATCH_WAKE_COOLDOWN_MS) {
        return { action: "none", state: previous };
    }

    if ((previous.wakes ?? 0) >= PR_WATCH_MAX_WAKES) {
        return { action: "end", reason: "cap", state: previous };
    }

    return {
        action: "wake",
        reasons,
        state: { ...next, lastWakeAt: now, wakes: (previous.wakes ?? 0) + 1 },
    };
};
