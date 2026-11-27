import { describe, expect, it } from "vitest";

import {
    decideWatch,
    PR_WATCH_MAX_WAKES,
    PR_WATCH_WAKE_COOLDOWN_MS,
    type PullRequestObservation,
    type PullRequestWatchState,
    stateOf,
    storedWatchOf,
} from "./pr-watch-logic";

const NOW = 1_000_000_000;

const quiet: PullRequestObservation = {
    checks: "passing",
    failingCheckNames: [],
    headSha: "aaa",
    mergeable: "clean",
    reviews: [],
    state: "open",
    watcherLogin: "dev",
};

const baselined: PullRequestWatchState = { baselined: true, headSha: "aaa", wakes: 0 };

describe("decideWatch", () => {
    it("ends the watch when the pull request is no longer open", () => {
        for (const state of ["closed", "merged"] as const) {
            expect(decideWatch(baselined, { ...quiet, state }, NOW)).toStrictEqual({ action: "end", reason: "closed", state: baselined });
        }
    });

    it("records the baseline silently, even when checks fail, the branch conflicts and a review exists", () => {
        const decision = decideWatch(
            {},
            { ...quiet, checks: "failing", failingCheckNames: ["ci"], mergeable: "conflicting", reviews: [{ authorLogin: "a", id: "r1" }] },
            NOW,
        );

        expect(decision.action).toBe("baseline");
        expect(decision.state).toStrictEqual({ baselined: true, checksHeadSha: "aaa", conflictHeadSha: "aaa", headSha: "aaa", reviewId: "r1" });
    });

    it("keeps no undefined keys in the baseline of a quiet pull request", () => {
        expect(decideWatch({}, quiet, NOW)).toStrictEqual({ action: "baseline", state: { baselined: true, headSha: "aaa" } });
    });

    it("a restart keeps the wake count, so it cannot reset the cap", () => {
        expect(decideWatch({ wakes: 3 }, quiet, NOW)).toStrictEqual({ action: "baseline", state: { baselined: true, headSha: "aaa", wakes: 3 } });
    });

    it("wakes once for failing checks on a new head, and not again for the same head", () => {
        const failing = { ...quiet, checks: "failing" as const, failingCheckNames: ["ci"], headSha: "bbb" };
        const first = decideWatch(baselined, failing, NOW);

        expect(first).toMatchObject({ action: "wake", reasons: ["checks"], state: { checksHeadSha: "bbb", headSha: "bbb", wakes: 1 } });

        if (first.action !== "wake") {
            throw new Error("expected a wake");
        }

        expect(decideWatch(first.state, failing, NOW + PR_WATCH_WAKE_COOLDOWN_MS + 1).action).toBe("none");
    });

    it("wakes on failing checks even when the host sent no check names", () => {
        expect(decideWatch(baselined, { ...quiet, checks: "failing", failingCheckNames: [], headSha: "bbb" }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["checks"],
        });
    });

    it("does not wake on pending or passing checks", () => {
        expect(decideWatch(baselined, { ...quiet, checks: "pending" }, NOW).action).toBe("none");
        expect(decideWatch(baselined, { ...quiet, checks: "passing" }, NOW).action).toBe("none");
    });

    it("wakes on a conflict, and treats an unknown mergeability as no change", () => {
        expect(decideWatch(baselined, { ...quiet, mergeable: "conflicting" }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["conflict"],
            state: { conflictHeadSha: "aaa" },
        });
        expect(decideWatch(baselined, { ...quiet, mergeable: "unknown" }, NOW)).toStrictEqual({ action: "none", state: { ...baselined, headSha: "aaa" } });
    });

    it("wakes on a review by someone else that is newer than the one seen", () => {
        expect(
            decideWatch(
                { ...baselined, reviewId: "r1" },
                {
                    ...quiet,
                    reviews: [
                        { authorLogin: "dev", id: "r3" },
                        { authorLogin: "reviewer", id: "r2" },
                        { authorLogin: "reviewer", id: "r1" },
                    ],
                },
                NOW,
            ),
        ).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r2" } });
    });

    it("wakes on the first review by someone else when none was seen at the baseline", () => {
        expect(decideWatch(baselined, { ...quiet, reviews: [{ authorLogin: "reviewer", id: "r2" }] }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["review"],
            state: { reviewId: "r2" },
        });
    });

    it("does not wake on the watcher's own review, and does not move the seen review", () => {
        expect(
            decideWatch(
                { ...baselined, reviewId: "r1" },
                {
                    ...quiet,
                    reviews: [
                        { authorLogin: "dev", id: "r3" },
                        { authorLogin: "reviewer", id: "r1" },
                    ],
                },
                NOW,
            ),
        ).toStrictEqual({
            action: "none",
            state: { ...baselined, headSha: "aaa", reviewId: "r1" },
        });
    });

    it("wakes on a review newer than a seen one that lies deep in the list, past the first page", () => {
        const listed = Array.from({ length: 250 }, (_, index) => {
            return { authorLogin: "reviewer", id: `r${String(250 - index)}` };
        });

        expect(decideWatch({ ...baselined, reviewId: "r100" }, { ...quiet, reviews: listed }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["review"],
            state: { reviewId: "r250" },
        });
    });

    it("clears the seen review when it was deleted and nobody else's review is listed, so the next review by someone else wakes", () => {
        const cleared = decideWatch({ ...baselined, reviewId: "r5" }, { ...quiet, reviews: [{ authorLogin: "dev", id: "r6" }] }, NOW);

        expect(cleared.action).toBe("none");
        expect(cleared.state.reviewId).toBeUndefined();

        expect(
            decideWatch(
                cleared.state,
                {
                    ...quiet,
                    reviews: [
                        { authorLogin: "reviewer", id: "r7" },
                        { authorLogin: "dev", id: "r6" },
                    ],
                },
                NOW,
            ),
        ).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r7" } });
    });

    it("re-baselines silently when the seen review left the list, so a later review still wakes", () => {
        const decision = decideWatch(
            { ...baselined, reviewId: "r5" },
            {
                ...quiet,
                reviews: [
                    { authorLogin: "reviewer", id: "r2" },
                    { authorLogin: "reviewer", id: "r1" },
                ],
            },
            NOW,
        );

        expect(decision).toStrictEqual({ action: "none", state: { ...baselined, headSha: "aaa", reviewId: "r2" } });

        expect(
            decideWatch(
                decision.state,
                {
                    ...quiet,
                    reviews: [
                        { authorLogin: "reviewer", id: "r3" },
                        { authorLogin: "reviewer", id: "r2" },
                    ],
                },
                NOW,
            ),
        ).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r3" } });
    });

    it("combines every reason seen in one read into one wake", () => {
        expect(
            decideWatch(
                baselined,
                {
                    ...quiet,
                    checks: "failing",
                    failingCheckNames: ["ci"],
                    headSha: "ccc",
                    mergeable: "conflicting",
                    reviews: [{ authorLogin: "reviewer", id: "r9" }],
                },
                NOW,
            ),
        ).toMatchObject({ action: "wake", reasons: ["checks", "conflict", "review"], state: { wakes: 1 } });
    });

    it("keeps an occurrence seen during the cooldown as pending, and delivers it after the cooldown even if the head moved on", () => {
        const recent = { ...baselined, lastWakeAt: NOW - 1000, wakes: 1 };
        const during = decideWatch(recent, { ...quiet, checks: "failing", failingCheckNames: ["ci"], headSha: "bbb" }, NOW);

        expect(during).toStrictEqual({
            action: "none",
            state: { ...recent, checksHeadSha: "bbb", headSha: "bbb", pending: ["checks"] },
        });

        if (during.action !== "none") {
            throw new Error("expected the wake to wait");
        }

        const later = decideWatch(during.state, { ...quiet, headSha: "ccc" }, NOW + PR_WATCH_WAKE_COOLDOWN_MS + 1);

        expect(later).toMatchObject({ action: "wake", reasons: ["checks"], state: { pending: undefined, wakes: 2 } });
    });

    it("ends a capped watch on its next read, even a quiet one", () => {
        const capped = { ...baselined, wakes: PR_WATCH_MAX_WAKES };

        expect(decideWatch(capped, quiet, NOW)).toStrictEqual({ action: "end", reason: "cap", state: capped });
        expect(decideWatch(capped, { ...quiet, mergeable: "conflicting" }, NOW)).toStrictEqual({ action: "end", reason: "cap", state: capped });
    });

    it("does nothing for a quiet read after a baseline", () => {
        expect(decideWatch(baselined, quiet, NOW)).toStrictEqual({ action: "none", state: { ...baselined, headSha: "aaa" } });
    });
});

describe("a seen review beyond a truncated read", () => {
    const listed = [
        { authorLogin: "dev", id: "109", submittedAt: 9000 },
        { authorLogin: "bob", id: "108", submittedAt: 6000 },
        { authorLogin: "amy", id: "107", submittedAt: 8000 },
    ];
    const marked = { ...baselined, reviewId: "50" };
    const present = { seenReviewBeyondRead: "present", seenReviewSubmittedAt: 5000 } as const;

    it("wakes for a review submitted after the seen one and marks the newest by submission time, not list position", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: listed, ...present }, NOW);

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "107" } });
    });

    it("does not wake for a review submitted before the seen one", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [{ authorLogin: "bob", id: "1", submittedAt: 4000 }], ...present }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "50" } });
    });

    it("wakes, and moves the marker, for a review submitted in the same second as the seen one (a spurious wake over a missed review)", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [{ authorLogin: "bob", id: "1", submittedAt: 5000 }], ...present }, NOW);

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "1" } });
    });

    it("does not take a review with no submission time for newer", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [{ authorLogin: "bob", id: "1" }], ...present }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "50" } });
    });

    it("re-baselines silently when the seen review was found deleted", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: listed, seenReviewBeyondRead: "gone" }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "108" } });
    });

    it("neither wakes nor moves the marker when the seen review could not be looked up", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: listed, seenReviewBeyondRead: "unknown" }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "50" } });
    });

    it("does not wake for the watcher's own reviews alone, even when the seen review exists", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [listed[0]!], ...present }, NOW);

        expect(decision.action).toBe("none");
    });

    it("still re-baselines silently when the list is complete and the marker is gone", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: listed }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "108" } });
    });
});

describe("a listed seen review in a list sorted by submission time", () => {
    const seen = { authorLogin: "bob", id: "5", submittedAt: 5000 };
    const marked = { ...baselined, reviewId: "5" };

    it("wakes, and moves the marker, for a review above it with an equal time (one-second resolution)", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [{ authorLogin: "amy", id: "6", submittedAt: 5000 }, seen] }, NOW);

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "6" } });
    });

    it("does not wake for a review below it, whatever its time", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [seen, { authorLogin: "amy", id: "4", submittedAt: 5000 }] }, NOW);

        expect(decision).toMatchObject({ action: "none", state: { reviewId: "5" } });
    });

    it("wakes for a strictly later one", () => {
        const decision = decideWatch(marked, { ...quiet, reviews: [{ authorLogin: "amy", id: "6", submittedAt: 5001 }, seen] }, NOW);

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "6" } });
    });
});

describe("the watcher's own reviews", () => {
    const own = { authorLogin: "Dev", id: "r9" };

    it("do not wake, whatever the letter case of the login", () => {
        const decision = decideWatch(baselined, { ...quiet, reviews: [own], watcherLogin: "dev" }, NOW);

        expect(decision.action).toBe("none");
        expect(decision.state.reviewId).toBeUndefined();
    });

    it("are not taken as the baseline's seen review", () => {
        expect(decideWatch({}, { ...quiet, reviews: [own], watcherLogin: "DEV" }, NOW).state.reviewId).toBeUndefined();
    });

    it("do not hide a later review by someone else", () => {
        const decision = decideWatch(
            { ...baselined, reviewId: "r1" },
            { ...quiet, reviews: [{ authorLogin: "bob", id: "r10" }, own, { authorLogin: "bob", id: "r1" }] },
            NOW,
        );

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r10" } });
    });

    it("may wake when the login is missing: every review newer than the marker counts as someone else's", () => {
        for (const watcherLogin of ["", "  "]) {
            const decision = decideWatch(
                { ...baselined, reviewId: "r1" },
                { ...quiet, reviews: [own, { authorLogin: "bob", id: "r2" }, { authorLogin: "bob", id: "r1" }], watcherLogin },
                NOW,
            );

            expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r9" } });
        }
    });

    it("do not wake with the login known, even when one was missing on an earlier read", () => {
        const reviews = [own, { authorLogin: "bob", id: "r2" }];
        const known = decideWatch({ ...baselined, reviewId: "r2" }, { ...quiet, reviews, watcherLogin: "dev" }, NOW);

        expect(known.action).toBe("none");
    });

    it("is not lost after a baseline with no review, whether the login is missing or back", () => {
        const first = decideWatch({}, { ...quiet, reviews: [], watcherLogin: "" }, NOW);
        const review = [{ authorLogin: "bob", id: "r1" }];

        expect(first.state.reviewId).toBeUndefined();
        // Login still missing: the review is counted as someone else's and wakes.
        expect(decideWatch(first.state, { ...quiet, reviews: review, watcherLogin: "" }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["review"],
            state: { reviewId: "r1" },
        });
        // Login back: the same review wakes the same way.
        expect(decideWatch(first.state, { ...quiet, reviews: review, watcherLogin: "dev" }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["review"],
            state: { reviewId: "r1" },
        });
    });

    it("with no login at the baseline, mark the newest review silently", () => {
        const reviews = [{ authorLogin: "bob", id: "r3" }, own];

        expect(decideWatch({}, { ...quiet, reviews, watcherLogin: "" }, NOW)).toMatchObject({ action: "baseline", state: { reviewId: "r3" } });
    });

    it("do not stop a missing login from waking for checks", () => {
        expect(decideWatch(baselined, { ...quiet, checks: "failing", watcherLogin: "" }, NOW)).toMatchObject({ action: "wake", reasons: ["checks"] });
    });
});

describe("storedWatchOf and stateOf", () => {
    it("round-trips the decision's state through the row's two stored fields", () => {
        const state = { baselined: true, checksHeadSha: "a", headSha: "b", lastWakeAt: 5, pending: ["checks", "review"] as const, reviewId: "r1", wakes: 2 };
        const stored = storedWatchOf({ ...state, pending: [...state.pending], startedAt: 1 });

        expect(stored.watch).toStrictEqual({ baselined: true, checksHeadSha: "a", headSha: "b", lastWakeAt: 5, reviewId: "r1", startedAt: 1, wakes: 2 });
        expect(stored.watchPending).toStrictEqual(["checks", "review"]);
        expect(stateOf(stored)).toStrictEqual({ ...state, pending: [...state.pending] });
    });

    it("keeps no pending key when none is stored", () => {
        const stored = storedWatchOf({ startedAt: 1, wakes: 1 });

        expect(stored).toStrictEqual({ watch: { startedAt: 1, wakes: 1 }, watchPending: undefined });
        expect(stateOf({ watch: stored.watch })).toStrictEqual({ wakes: 1 });
    });
});
