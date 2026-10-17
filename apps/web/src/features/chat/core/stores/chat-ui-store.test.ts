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
