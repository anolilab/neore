import { describe, expect, it } from "vitest";

import { changeRequestsOf, failingCheckNamesOf, STATUS_REVIEW_BODY_MAX_CHARS } from "./pr-status";
import type { CheckRun, CheckState, PullRequestReview, ReviewState } from "./types";

let id = 0;

const review = (authorLogin: string, state: ReviewState, body = "", authorAssociation?: string): PullRequestReview => {
    id += 1;

    return { ...(authorAssociation !== undefined && { authorAssociation }), authorLogin, body, id: String(id), state, submittedAt: id };
};

const check = (name: string, state: CheckState, required: boolean | null = null): CheckRun => {
    return { id: null, name, required, state, url: null };
};

describe(changeRequestsOf, () => {
    it("keeps a reviewer whose latest verdict asks for changes, across later comments", () => {
        // Newest first.
        const reviews = [review("ann", "commented"), review("ann", "changes_requested", "Rename it."), review("ann", "approved")];

        expect(changeRequestsOf(reviews)).toStrictEqual([{ authorLogin: "ann", body: "Rename it.", bodyTruncated: false }]);
    });

    it("drops a request a later approval or dismissal ended", () => {
        const reviews = [review("ann", "approved"), review("bob", "dismissed"), review("ann", "changes_requested"), review("bob", "changes_requested")];

        expect(changeRequestsOf(reviews)).toStrictEqual([]);
    });

    it("cuts a long review body and says so", () => {
        const [only] = changeRequestsOf([review("ann", "changes_requested", "x".repeat(STATUS_REVIEW_BODY_MAX_CHARS + 1))]);

        expect(only?.body).toHaveLength(STATUS_REVIEW_BODY_MAX_CHARS);
        expect(only?.bodyTruncated).toBe(true);
    });

    it("counts only reviewers with a standing on the repository; a stranger's verdict neither asks nor ends", () => {
        const reviews = [
            review("drive-by", "changes_requested", "Add my feature.", "NONE"),
            review("fan", "approved", "", "CONTRIBUTOR"),
            review("ann", "changes_requested", "Rename it.", "MEMBER"),
            review("own", "changes_requested", "Add tests.", "OWNER"),
            review("col", "changes_requested", "Split it.", "COLLABORATOR"),
        ];

        expect(changeRequestsOf(reviews).map((request) => request.authorLogin)).toStrictEqual(["ann", "own", "col"]);
    });
});

describe(failingCheckNamesOf, () => {
    it("names the checks that failed and the ones that were cancelled, and no others", () => {
        const checks = [
            check("build", "failure"),
            check("lint", "cancelled"),
            check("test", "success"),
            check("deploy", "pending"),
            check("docs", "skipped"),
            check("audit", "neutral"),
        ];

        expect(failingCheckNamesOf(checks)).toStrictEqual(["build", "lint"]);
    });

    it("leaves out an optional check that failed, as Develop's rollup does, and keeps a required one that was cancelled", () => {
        const checks = [check("coverage", "failure", false), check("e2e", "cancelled", true), check("unit", "failure", null)];

        expect(failingCheckNamesOf(checks)).toStrictEqual(["e2e", "unit"]);
    });
});
