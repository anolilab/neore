import { describe, expect, it } from "vitest";

import type { DraftComment, DraftState } from "./draft-logic";
import { commitFor, isSubmitting, SUBMIT_LEASE_MS, submitBlocker, withoutSent } from "./draft-logic";

const comment = (id: string): DraftComment => {
    return { body: "x", createdAt: 1, id, line: 3, path: "a.ts", side: "new", startLine: null };
};

const draft = (overrides: Partial<DraftState> = {}): DraftState => {
    return { body: "", comments: [], commitId: "a".repeat(40), submittingAt: 0, verdict: null, ...overrides };
};

describe("isSubmitting", () => {
    it("is true only while a claim's lease runs", () => {
        expect(isSubmitting({ submittingAt: 0 }, 1_000_000)).toBe(false);
        expect(isSubmitting({ submittingAt: 1000 }, 1000 + SUBMIT_LEASE_MS - 1)).toBe(true);
        expect(isSubmitting({ submittingAt: 1000 }, 1000 + SUBMIT_LEASE_MS)).toBe(false);
    });
});

describe("commitFor", () => {
    const head = "b".repeat(40);

    it("follows the head while the draft has no comments, and keeps it once it has", () => {
        expect(commitFor(null, head)).toBe(head);
        expect(commitFor(draft(), head)).toBe(head);
        expect(commitFor(draft({ comments: [comment("1")] }), "a".repeat(40))).toBe("a".repeat(40));
    });

    it("refuses a newer head once the draft holds comments written against the old one", () => {
        expect(commitFor(draft({ comments: [comment("1")] }), head)).toBe("head_moved");
    });
});

describe("submitBlocker", () => {
    it("needs a verdict", () => {
        expect(submitBlocker(draft({ comments: [comment("1")] }))).toBe("needs_verdict");
    });

    it("lets an approval go with nothing to say", () => {
        expect(submitBlocker(draft({ verdict: "approve" }))).toBeNull();
    });

    it("needs words to request changes, and words or comments to comment", () => {
        expect(submitBlocker(draft({ comments: [comment("1")], verdict: "request_changes" }))).toBe("needs_text");
        expect(submitBlocker(draft({ body: "  ", verdict: "request_changes" }))).toBe("needs_text");
        expect(submitBlocker(draft({ body: "no", verdict: "request_changes" }))).toBeNull();
        expect(submitBlocker(draft({ verdict: "comment" }))).toBe("needs_text");
        expect(submitBlocker(draft({ comments: [comment("1")], verdict: "comment" }))).toBeNull();
    });
});

describe("withoutSent", () => {
    it("keeps the comments the host did not receive", () => {
        expect(withoutSent([comment("1"), comment("2"), comment("3")], ["1", "3"]).map((entry) => entry.id)).toEqual(["2"]);
    });
});
