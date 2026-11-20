import { beforeEach, describe, expect, it } from "vitest";

import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import { composerDraftFrom, draftFromField, markComposerDraft, noteSavedPrompt } from "./draft-origin";

const ui = () => useChatUIStore.getState();

const attachment = { file: new File([], "a.txt"), id: "a1", name: "a.txt", status: "complete", type: "file" } as PendingAttachment;

beforeEach(() => {
    ui().reset();
});

describe("the composer draft's not-typed mark", () => {
    it("stays on a short link draft the owner adds words to", () => {
        ui().setComposerText("ok");
        markComposerDraft("promptLink");
        ui().setComposerText("ok, and book the flight for me");

        expect(composerDraftFrom()).toBe("promptLink");
        expect(draftFromField(composerDraftFrom())).toStrictEqual({ draftFrom: "promptLink" });
    });

    it("stays on a long draft edited down to the end of its text", () => {
        const imported = `${"a".repeat(25_000)} then sign in to my bank`;

        ui().setComposerText(imported);
        markComposerDraft("shellLink");
        ui().setComposerText(imported.slice(24_990));

        expect(composerDraftFrom()).toBe("shellLink");
    });

    it("goes once the draft is sent or emptied, so the owner's next draft is their own", () => {
        ui().setComposerText("from a link");
        markComposerDraft("promptLink");
        ui().clearComposer();
        ui().setComposerText("from a link");

        expect(composerDraftFrom()).toBeUndefined();

        ui().setComposerText("again from a link");
        markComposerDraft("promptLink");
        ui().setComposerText("");
        ui().setComposerText("typed by me");

        expect(composerDraftFrom()).toBeUndefined();
        expect(draftFromField(composerDraftFrom())).toStrictEqual({});
    });

    it("stays while an attachment is left in the draft, and goes with the last of it", () => {
        ui().setComposerText("from a link");
        markComposerDraft("promptLink");
        useChatUIStore.setState({ composerAttachments: [attachment] });
        ui().setComposerText("");

        expect(composerDraftFrom()).toBe("promptLink");

        ui().removeAttachment("a1");

        expect(composerDraftFrom()).toBeUndefined();
    });

    it("goes with the last reference image, and is never set on an empty draft", () => {
        ui().setComposerText("from a link");
        markComposerDraft("promptLink");
        ui().setAttachedReferences([{ id: "r1", mimeType: "image/png", url: "https://example.test/r1.png" }]);
        ui().setComposerText("");
        ui().removeAttachedReference("r1");

        expect(composerDraftFrom()).toBeUndefined();

        markComposerDraft("shellLink");
        ui().setComposerText("typed by me");

        expect(composerDraftFrom()).toBeUndefined();
    });

    it("comes back with a draft restored into the composer", () => {
        ui().restoreComposer({ attachedReferences: [], composerAttachments: [], composerDraftFrom: "sharedPrompt", composerText: "a colleague's prompt" });

        expect(composerDraftFrom()).toBe("sharedPrompt");
    });

    it("marks someone else's saved prompt, and the owner's own prompt replacing it drops the mark", () => {
        ui().setComposerText("A colleague's prompt that signs in somewhere");
        noteSavedPrompt({ userId: "user-b" }, "user-a", { replaced: true });

        expect(composerDraftFrom()).toBe("sharedPrompt");

        ui().setComposerText("A colleague's prompt that signs in somewhere");
        noteSavedPrompt({ userId: "user-a" }, "user-a", { replaced: true });

        expect(composerDraftFrom()).toBeUndefined();
    });

    it("keeps the mark when the owner's own prompt goes into marked text, and counts an unknown viewer as someone else", () => {
        ui().setComposerText("from a link");
        markComposerDraft("promptLink");
        ui().setComposerText("from a link and my own prompt");
        noteSavedPrompt({ userId: "user-a" }, "user-a", { replaced: false });

        expect(composerDraftFrom()).toBe("promptLink");

        ui().clearComposer();
        ui().setComposerText("read before the session loaded");
        noteSavedPrompt({ userId: "user-c" }, undefined, { replaced: true });

        expect(composerDraftFrom()).toBe("sharedPrompt");
    });
});
