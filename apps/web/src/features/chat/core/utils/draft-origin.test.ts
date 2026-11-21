import { beforeEach, describe, expect, it, vi } from "vitest";

import { handOffLandingMessage, LANDING_MESSAGE_FROM_KEY, takeLandingMessage } from "@/features/marketing/stores/landing-store";

import type { PendingAttachment } from "../stores/chat-ui-store";
import { useChatUIStore } from "../stores/chat-ui-store";
import {
    composerDraftFrom,
    draftFromField,
    holdLandingDraft,
    isOwnPromptContent,
    markComposerDraft,
    markPrefilledDraft,
    noteSavedPrompt,
    prefillDraftFrom,
} from "./draft-origin";

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

describe(isOwnPromptContent, () => {
    it("counts a prompt as the viewer's only when they wrote all of its current words themselves", () => {
        expect(isOwnPromptContent({ contentBy: "user-a", contentByImpersonator: false, userId: "user-a" }, "user-a")).toBe(true);
        // A teammate's organization prompt whose words are all the viewer's (the backend records no other writer).
        expect(isOwnPromptContent({ contentBy: "user-a", contentByImpersonator: false, organizationId: "org", userId: "user-b" }, "user-a")).toBe(true);
    });

    it("refuses the viewer's prompt a teammate rewrote or wrote part of, and one an admin wrote any of while acting as the viewer", () => {
        expect(isOwnPromptContent({ contentBy: "user-b", contentByImpersonator: false, organizationId: "org", userId: "user-a" }, "user-a")).toBe(false);
        expect(isOwnPromptContent({ contentBy: "user-a", contentByImpersonator: true, userId: "user-a" }, "user-a")).toBe(false);
        expect(isOwnPromptContent({ contentBy: "user-a", contentByImpersonator: false, contentByOthers: true, userId: "user-a" }, "user-a")).toBe(false);
        expect(isOwnPromptContent({ contentBy: "user-a", userId: "user-a" }, undefined)).toBe(false);
    });

    it("reads a row from before the writer was recorded as the viewer's only for their own personal prompt", () => {
        expect(isOwnPromptContent({ userId: "user-a" }, "user-a")).toBe(true);
        expect(isOwnPromptContent({ organizationId: "org", userId: "user-a" }, "user-a")).toBe(false);
        expect(isOwnPromptContent({ userId: "user-b" }, "user-a")).toBe(false);
    });

    it("marks the draft when the viewer's own prompt holds a teammate's edit, even replacing the whole draft", () => {
        ui().setComposerText("my prompt, rewritten by a teammate");
        noteSavedPrompt({ contentBy: "user-b", contentByImpersonator: false, organizationId: "org", userId: "user-a" }, "user-a", { replaced: true });

        expect(composerDraftFrom()).toBe("sharedPrompt");
    });
});

describe(prefillDraftFrom, () => {
    it("marks a chat's `?initialMessage=` prefill, which a link wrote, and not the new chat's hand-off of typed text", () => {
        holdLandingDraft("my words", undefined);

        expect(prefillDraftFrom("thread-1", "my words")).toBe("promptLink");
        expect(prefillDraftFrom(undefined, "my words")).toBeUndefined();
    });

    it("gives the new chat's prefill its hand-off's mark each time it is applied, and only for that text", () => {
        holdLandingDraft("> quoted", "forwarded");

        expect(prefillDraftFrom(undefined, "> quoted")).toBe("forwarded");
        // A remounted composer applies the same prefill again.
        expect(prefillDraftFrom(undefined, "> quoted")).toBe("forwarded");
        expect(prefillDraftFrom(undefined, "other text")).toBeUndefined();

        holdLandingDraft("a template", "suggestion");

        expect(prefillDraftFrom(undefined, "a template")).toBe("suggestion");
        expect(prefillDraftFrom(undefined, "> quoted")).toBeUndefined();
    });
});

/** The chat index reading a hand-off, then the composer putting its text in (`chat/index.tsx`, `composer.tsx`). */
const applyHandOff = (): void => {
    const handOff = takeLandingMessage();

    if (handOff) {
        holdLandingDraft(handOff.text, handOff.from);
        ui().setComposerText(handOff.text);
        markPrefilledDraft(undefined, handOff.text);
    }
};

describe(markPrefilledDraft, () => {
    it("clears an unsent draft's mark when typed text from the home page replaces it", () => {
        ui().setComposerText("> quoted");
        markComposerDraft("forwarded");

        handOffLandingMessage("my words");
        applyHandOff();

        expect(composerDraftFrom()).toBeUndefined();
    });

    it("marks a forwarded hand-off that replaces the person's own unsent draft, again after a remount", () => {
        ui().setComposerText("my words");

        handOffLandingMessage("> quoted", "forwarded");
        applyHandOff();

        expect(composerDraftFrom()).toBe("forwarded");

        markPrefilledDraft(undefined, "> quoted");

        expect(composerDraftFrom()).toBe("forwarded");
    });
});

describe(handOffLandingMessage, () => {
    it("hands forwarded text over with its mark, and typed text with none left over from an earlier hand-off", () => {
        handOffLandingMessage("> quoted", "forwarded");

        expect(takeLandingMessage()).toStrictEqual({ from: "forwarded", text: "> quoted" });
        expect(takeLandingMessage()).toBeUndefined();

        handOffLandingMessage("> quoted", "forwarded");
        handOffLandingMessage("my words");

        expect(takeLandingMessage()).toStrictEqual({ from: undefined, text: "my words" });
    });

    it("leaves no text without its mark when a replacing write fails part way", () => {
        const quotaError = () => {
            throw new DOMException("full", "QuotaExceededError");
        };

        // Typed text replacing a marked template: the text's write fails after the old mark was cleared.
        handOffLandingMessage("a template", "suggestion");
        const textWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(quotaError);

        expect(() => handOffLandingMessage("my words")).toThrow("full");
        expect(takeLandingMessage()).toBeUndefined();

        // A marked hand-off whose mark's write fails replaces nothing with unmarked text.
        textWrite.mockRestore();
        handOffLandingMessage("my words");
        const markWrite = vi.spyOn(Storage.prototype, "setItem").mockImplementation(quotaError);

        expect(() => handOffLandingMessage("> quoted", "forwarded")).toThrow("full");
        markWrite.mockRestore();
        expect(takeLandingMessage()).toBeUndefined();
    });

    it("reads a mark nobody named as a link's", () => {
        handOffLandingMessage("> quoted");
        sessionStorage.setItem(LANDING_MESSAGE_FROM_KEY, "typed");

        expect(takeLandingMessage()).toStrictEqual({ from: "promptLink", text: "> quoted" });
    });
});
