import { describe, expect, it } from "vitest";

import { vThread } from "./review-functions";

const thread = {
    canResolve: true,
    canUnresolve: false,
    comments: [{ authorLogin: "reviewer", body: "Why?", createdAt: 1, id: "1001" }],
    id: "PRRT_kwDOA",
    isOutdated: false,
    isResolved: false,
    line: 12,
    path: "src/a.ts",
    side: "new",
    startLine: null,
};

describe("review thread output", () => {
    it("accepts a comment with its host page, and one without", () => {
        const withUrl = { ...thread, comments: [{ ...thread.comments[0], url: "https://github.com/acme/app/pull/7#discussion_r1001" }] };

        expect(vThread.safeParse(withUrl).ok).toBe(true);
        expect(vThread.safeParse(thread).ok).toBe(true);
    });
});
