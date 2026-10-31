import { beforeEach, describe, expect, it } from "vitest";

import { MAX_DRAFT_COMMENTS, useDiffCommentStore } from "./diff-comments-store";

beforeEach(() => {
    useDiffCommentStore.setState({ drafts: {} });
});

describe("the diff comment draft", () => {
    it("says whether it stored a comment, and stores none past its limit", () => {
        const { add } = useDiffCommentStore.getState();

        for (let index = 0; index < MAX_DRAFT_COMMENTS; index += 1) {
            expect(add("t1", { messageId: "m1", path: "a.ts", text: String(index) })).toBe(true);
        }

        expect(add("t1", { messageId: "m1", path: "a.ts", text: "one too many" })).toBe(false);
        expect(useDiffCommentStore.getState().drafts.t1).toHaveLength(MAX_DRAFT_COMMENTS);
        // Another thread has its own draft.
        expect(add("t2", { messageId: "m1", path: "a.ts", text: "fits" })).toBe(true);
    });
});
