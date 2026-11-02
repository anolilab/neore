import { describe, expect, it, vi } from "vitest";

import { draftFitsAsFile, moveDraftToFile, undoLongPaste } from "./composer-draft-file";

describe("moveDraftToFile", () => {
    const setup = (result: { attachmentId: string; error?: string }, current = "draft") => {
        const state = { attachments: [result.attachmentId], text: current };
        const options = {
            attach: vi.fn(async () => result),
            clearDraft: vi.fn(() => {
                state.text = "";
            }),
            discard: vi.fn(),
            getAttachmentIds: () => state.attachments,
            getDraft: () => state.text,
            onFailure: vi.fn(),
        };

        return { options, state };
    };

    it("empties the composer once the upload succeeded", async () => {
        const { options, state } = setup({ attachmentId: "a1" });

        expect(await moveDraftToFile(options)).toBe(true);
        expect(state.text).toBe("");
        expect(options.discard).not.toHaveBeenCalled();
    });

    it("keeps the draft, drops the failed chip and reports the reason when the upload failed", async () => {
        const { options, state } = setup({ attachmentId: "a1", error: "Too big" });

        expect(await moveDraftToFile(options)).toBe(false);
        expect(state.text).toBe("draft");
        expect(options.clearDraft).not.toHaveBeenCalled();
        expect(options.discard).toHaveBeenCalledWith("a1");
        expect(options.onFailure).toHaveBeenCalledWith("Too big");
    });

    it("leaves text typed during the upload", async () => {
        const { options, state } = setup({ attachmentId: "a1" });

        options.attach.mockImplementation(async () => {
            state.text = "draft and more";

            return { attachmentId: "a1" };
        });

        await moveDraftToFile(options);

        expect(state.text).toBe("draft and more");
    });
});

describe("moveDraftToFile when the file is removed during the upload", () => {
    it("keeps the draft", async () => {
        const state = { attachments: ["a1"], text: "draft" };
        const clearDraft = vi.fn(() => {
            state.text = "";
        });

        await moveDraftToFile({
            attach: async () => {
                state.attachments = [];

                return { attachmentId: "a1" };
            },
            clearDraft,
            discard: vi.fn(),
            getAttachmentIds: () => state.attachments,
            getDraft: () => state.text,
            onFailure: vi.fn(),
        });

        expect(clearDraft).not.toHaveBeenCalled();
        expect(state.text).toBe("draft");
    });
});

describe("draftFitsAsFile", () => {
    const limits = { contextChars: 400_000, maxFileBytes: 25 * 1024 * 1024 };

    it("fits below the context error threshold", () => {
        expect(draftFitsAsFile("x".repeat(399_999), 0, limits)).toBe(true);
    });

    it("does not fit at 400,000 ASCII characters", () => {
        expect(draftFitsAsFile("x".repeat(400_000), 0, limits)).toBe(false);
    });

    it("counts bytes, not characters, and the attachments already there", () => {
        expect(draftFitsAsFile("é".repeat(200_000), 0, limits)).toBe(false);
        expect(draftFitsAsFile("x".repeat(150_000), 300_000, limits)).toBe(false);
    });

    it("does not fit a file over the attachment limit", () => {
        expect(draftFitsAsFile("x".repeat(10), 0, { contextChars: 400_000, maxFileBytes: 5 })).toBe(false);
    });
});

describe("undoLongPaste", () => {
    it("puts the text back and drops the file while the file is attached", () => {
        const removeAttachment = vi.fn();
        const setDraft = vi.fn();

        expect(
            undoLongPaste({ attachmentId: "a1", getAttachmentIds: () => ["a1"], getDraft: () => "hi ", pastedText: "long", removeAttachment, setDraft }),
        ).toBe(true);
        expect(removeAttachment).toHaveBeenCalledWith("a1");
        expect(setDraft).toHaveBeenCalledWith("hi long");
    });

    it("does nothing once the file was sent or removed", () => {
        const removeAttachment = vi.fn();
        const setDraft = vi.fn();

        expect(undoLongPaste({ attachmentId: "a1", getAttachmentIds: () => [], getDraft: () => "", pastedText: "long", removeAttachment, setDraft })).toBe(
            false,
        );
        expect(removeAttachment).not.toHaveBeenCalled();
        expect(setDraft).not.toHaveBeenCalled();
    });
});
