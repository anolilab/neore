import { describe, expect, it } from "vitest";

import { decideWatch, PR_WATCH_MAX_WAKES, PR_WATCH_WAKE_COOLDOWN_MS, type PullRequestObservation, type PullRequestWatchState } from "./pr-watch-logic";

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
        expect(decision.state).toStrictEqual({
            baselined: true,
            checksHeadSha: "aaa",
            conflictHeadSha: "aaa",
            headSha: "aaa",
            reviewId: "r1",
        });
    });

    it("keeps no undefined keys in the baseline of a quiet pull request", () => {
        const decision = decideWatch({}, quiet, NOW);

        expect(decision).toStrictEqual({ action: "baseline", state: { baselined: true, headSha: "aaa" } });
    });

    it("a restart keeps the wake count, so it cannot reset the cap", () => {
        const decision = decideWatch({ wakes: 3 }, quiet, NOW);

        expect(decision).toStrictEqual({ action: "baseline", state: { baselined: true, headSha: "aaa", wakes: 3 } });
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

    it("does not wake on pending or passing checks, or on failing checks with no names", () => {
        expect(decideWatch(baselined, { ...quiet, checks: "pending" }, NOW).action).toBe("none");
        expect(decideWatch(baselined, { ...quiet, checks: "passing" }, NOW).action).toBe("none");
        expect(decideWatch(baselined, { ...quiet, checks: "failing", failingCheckNames: [] }, NOW).action).toBe("none");
    });

    it("wakes on a conflict, and treats an unknown mergeability as no change", () => {
        expect(decideWatch(baselined, { ...quiet, mergeable: "conflicting" }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["conflict"],
            state: { conflictHeadSha: "aaa" },
        });
        expect(decideWatch(baselined, { ...quiet, mergeable: "unknown" }, NOW)).toStrictEqual({
            action: "none",
            state: { ...baselined, headSha: "aaa" },
        });
    });

    it("wakes on a new review by someone else", () => {
        expect(decideWatch(baselined, { ...quiet, reviews: [{ authorLogin: "reviewer", id: "r2" }] }, NOW)).toMatchObject({
            action: "wake",
            reasons: ["review"],
            state: { reviewId: "r2" },
        });
    });

    it("does not wake on the watcher's own review, and does not record it as the newest either", () => {
        const decision = decideWatch({ ...baselined, reviewId: "r1" }, { ...quiet, reviews: [{ authorLogin: "dev", id: "r3" }] }, NOW);

        expect(decision).toStrictEqual({ action: "none", state: { ...baselined, headSha: "aaa", reviewId: "r1" } });
    });

    it("still wakes for a review by someone else that came before the watcher's own", () => {
        const decision = decideWatch(
            { ...baselined, reviewId: "r1" },
            {
                ...quiet,
                reviews: [
                    { authorLogin: "dev", id: "r3" },
                    { authorLogin: "reviewer", id: "r2" },
                ],
            },
            NOW,
        );

        expect(decision).toMatchObject({ action: "wake", reasons: ["review"], state: { reviewId: "r2" } });
    });

    it("combines every reason seen in one read into one wake", () => {
        const decision = decideWatch(
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
        );

        expect(decision).toMatchObject({ action: "wake", reasons: ["checks", "conflict", "review"], state: { wakes: 1 } });
    });

    it("waits out the cooldown without recording the occurrence, so the next read still wants it", () => {
        const recent = { ...baselined, lastWakeAt: NOW - 1000, wakes: 1 };

        expect(decideWatch(recent, { ...quiet, mergeable: "conflicting" }, NOW)).toStrictEqual({ action: "none", state: recent });
    });

    it("ends the watch once the wake cap is reached, instead of waking again", () => {
        const capped = { ...baselined, wakes: PR_WATCH_MAX_WAKES };

        expect(decideWatch(capped, { ...quiet, mergeable: "conflicting" }, NOW)).toStrictEqual({ action: "end", reason: "cap", state: capped });
    });
});
