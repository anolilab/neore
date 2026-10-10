import { describe, expect, it } from "vitest";

import { applyCommentMark, collectCommentAnchors, reconcileCommentAnchors, sameContentIgnoringComments, stripCommentMarks } from "./comment-anchors";

const text = (value: string, marks?: unknown[]) => (marks ? { marks, text: value, type: "text" } : { text: value, type: "text" });
const comment = (commentId: string) => {
    return { attrs: { commentId }, type: "comment" };
};
const paragraph = (...content: unknown[]) => {
    return { content, type: "paragraph" };
};
const doc = (...content: unknown[]) => {
    return { content, type: "doc" };
};

describe("collectCommentAnchors", () => {
    it("maps each comment id to the text it covers, joining split runs", () => {
        const document = doc(
            paragraph(text("The "), text("quick", [comment("c1")]), text(" "), text("brown", [comment("c1"), { type: "bold" }]), text(" fox")),
        );

        expect(collectCommentAnchors(document).get("c1")).toBe("quickbrown");
    });
});

describe("re-anchoring after edits", () => {
    it("keeps an anchor whose mark survived an edit around it, and adopts its new text", () => {
        // The user typed inside the commented range; ProseMirror kept the mark.
        const edited = doc(paragraph(text("The "), text("very quick", [comment("c1")]), text(" fox")));
        const result = reconcileCommentAnchors(edited, [{ anchorText: "quick", commentId: "c1", orphaned: false }]);

        expect(result.outcomes).toEqual([{ anchorText: "very quick", commentId: "c1", kind: "anchored" }]);
        expect(result.doc).toBe(edited);
    });

    it("re-applies a lost mark on the quote when the content was replaced wholesale", () => {
        // An agent rewrite from markdown: same words, no marks, text elsewhere changed.
        const rewritten = doc(paragraph(text("Intro added.")), paragraph(text("The quick brown fox jumps")));
        const result = reconcileCommentAnchors(rewritten, [{ anchorText: "quick brown", commentId: "c1", orphaned: false }]);

        expect(result.outcomes).toEqual([{ anchorText: "quick brown", commentId: "c1", kind: "reanchored" }]);
        expect(collectCommentAnchors(result.doc).get("c1")).toBe("quick brown");
        // Nothing but the mark changed.
        expect(sameContentIgnoringComments(result.doc, rewritten)).toBe(true);
    });

    it("re-anchors across differently-marked text nodes within one block", () => {
        const document = doc(paragraph(text("The "), text("quick", [{ type: "bold" }]), text(" brown fox")));
        const next = applyCommentMark(document, "c1", "quick brown");

        expect(collectCommentAnchors(next).get("c1")).toBe("quick brown");
        // The bold mark is preserved on its piece.
        expect(JSON.stringify(next)).toContain('"bold"');
    });

    it("orphans a comment whose text is gone, and re-anchors it once the text returns", () => {
        const removed = doc(paragraph(text("Something else entirely")));
        const first = reconcileCommentAnchors(removed, [{ anchorText: "quick", commentId: "c1", orphaned: false }]);

        expect(first.outcomes).toEqual([{ commentId: "c1", kind: "orphaned" }]);
        expect(first.doc).toBe(removed);

        const restored = doc(paragraph(text("The quick fox")));
        const second = reconcileCommentAnchors(restored, [{ anchorText: "quick", commentId: "c1", orphaned: true }]);

        expect(second.outcomes[0]?.kind).toBe("reanchored");
    });

    it("does not match a quote that spans two blocks", () => {
        const split = doc(paragraph(text("The quick")), paragraph(text("brown fox")));

        expect(applyCommentMark(split, "c1", "quick brown")).toBeNull();
    });

    it("does not mutate its input", () => {
        const original = doc(paragraph(text("The quick fox")));
        const snapshot = JSON.stringify(original);

        applyCommentMark(original, "c1", "quick");

        expect(JSON.stringify(original)).toBe(snapshot);
    });
});

describe("comparing content", () => {
    it("ignores comment marks, text-node splits and key order", () => {
        const marked = doc(paragraph(text("The "), text("quick", [comment("c1")]), text(" fox")));
        const plain = { content: [{ content: [{ text: "The quick fox", type: "text" }], type: "paragraph" }], type: "doc" };

        expect(sameContentIgnoringComments(marked, plain)).toBe(true);
    });

    it("sees a real edit", () => {
        expect(sameContentIgnoringComments(doc(paragraph(text("a"))), doc(paragraph(text("b"))))).toBe(false);
        expect(sameContentIgnoringComments(doc(paragraph(text("a", [{ type: "bold" }]))), doc(paragraph(text("a"))))).toBe(false);
    });

    it("strips only comment marks", () => {
        const stripped = stripCommentMarks(doc(paragraph(text("x", [comment("c1"), { type: "bold" }]), text("y", [comment("c2")]))));

        expect(stripped).toEqual(doc(paragraph(text("x", [{ type: "bold" }]), text("y"))));
    });
});
