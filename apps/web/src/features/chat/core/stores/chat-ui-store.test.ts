import { beforeEach, describe, expect, it } from "vitest";

import type { ReferenceSelection } from "@/features/chat/components/reference-picker/types";

import type { PendingAttachment } from "./chat-ui-store";
import { useChatUIStore } from "./chat-ui-store";

const attachment = { fileId: "file-1", id: "a1", status: "complete" } as PendingAttachment;
const reference = { id: "r1", url: "https://example.com/r1.png" } as ReferenceSelection;
const draft = { attachedReferences: [reference], composerAttachments: [attachment], composerText: "hello" };

describe("restoreComposer", () => {
    beforeEach(() => {
        useChatUIStore.getState().reset();
    });

    it("puts text, attachments and references back into an empty composer", () => {
        useChatUIStore.getState().restoreComposer(draft);

        const { attachedReferences, composerAttachments, composerText } = useChatUIStore.getState();

        expect({ attachedReferences, composerAttachments, composerText }).toStrictEqual(draft);
    });

    it.each([
        ["text", { composerText: "new draft" }],
        ["attachments", { composerAttachments: [{ ...attachment, id: "a2" }] }],
        ["references", { attachedReferences: [{ ...reference, id: "r2" }] }],
    ])("leaves a draft with only %s alone", (_, started) => {
        useChatUIStore.setState(started);
        const before = useChatUIStore.getState();

        useChatUIStore.getState().restoreComposer(draft);

        const after = useChatUIStore.getState();

        expect(after.composerText).toBe(before.composerText);
        expect(after.composerAttachments).toBe(before.composerAttachments);
        expect(after.attachedReferences).toBe(before.attachedReferences);
    });
});

describe("setComposerText hidden characters", () => {
    beforeEach(() => {
        useChatUIStore.getState().reset();
    });

    it("keeps tag characters out of the draft and counts what it removed", () => {
        useChatUIStore.getState().setComposerText("hi\u{E0041}\u{E0042} there\u{202E}");

        expect(useChatUIStore.getState().composerText).toBe("hi there");
        expect(useChatUIStore.getState().composerHiddenRemoved).toBe(3);
    });

    it("forgets the count once the draft is empty", () => {
        useChatUIStore.getState().setComposerText("a\u{E0041}");
        useChatUIStore.getState().setComposerText("");

        expect(useChatUIStore.getState().composerHiddenRemoved).toBe(0);
    });

    it("still reports what was removed when the draft is left empty by it", () => {
        useChatUIStore.getState().setComposerText("\u{E0041}\u{E0042}");

        expect(useChatUIStore.getState().composerText).toBe("");
        expect(useChatUIStore.getState().composerHiddenRemoved).toBe(2);
    });

    it("adds characters removed from a paste that became a file", () => {
        useChatUIStore.getState().setComposerText("a\u{E0041}");
        useChatUIStore.getState().noteComposerHiddenRemoved(4);

        expect(useChatUIStore.getState().composerHiddenRemoved).toBe(5);
    });

    it("does not count the same characters again when the cleaned text comes back", () => {
        useChatUIStore.getState().setComposerText("a\u{E0041}b");
        useChatUIStore.getState().setComposerText("ab");
        useChatUIStore.getState().setComposerText("abc");

        expect(useChatUIStore.getState().composerHiddenRemoved).toBe(1);
    });
});
