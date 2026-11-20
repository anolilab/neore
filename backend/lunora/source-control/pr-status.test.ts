import { describe, expect, it } from "vitest";

import { changeRequestsOf, STATUS_REVIEW_BODY_MAX_CHARS } from "./pr-status";
import type { PullRequestReview, ReviewState } from "./types";

let id = 0;

const review = (authorLogin: string, state: ReviewState, body = ""): PullRequestReview => {
    id += 1;

    return { authorLogin, body, id: String(id), state, submittedAt: id };
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
});
