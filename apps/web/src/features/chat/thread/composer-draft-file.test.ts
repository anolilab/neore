import { describe, expect, it, vi } from "vitest";

import { attachLongPaste, draftFitsAsFile, insertPastedText, moveDraftToFile, pasteHasText, undoLongPaste } from "./composer-draft-file";

describe("attachLongPaste", () => {
    const setup = (result: { attachmentId: string; error?: string }, draft = "before after") => {
        const state = { chat: "chat-1" as string | null, ids: [result.attachmentId], text: draft };
        const options = {
            attach: vi.fn(async () => result),
            discard: vi.fn(),
            getAttachmentIds: () => state.ids,
            getChatKey: () => state.chat,
            getDraft: () => state.text,
            onAttached: vi.fn(),
            onFailure: vi.fn(),
            onNotInserted: vi.fn(),
            pastedText: "PASTED",
            selection: { end: 6, start: 6 },
            setDraft: vi.fn((text: string) => {
                state.text = text;
            }),
        };

        return { options, state };
    };

    it("reports the file and leaves the composer alone when the upload worked", async () => {
        const { options, state } = setup({ attachmentId: "a1" });

        expect(await attachLongPaste(options)).toBe(true);
        expect(options.onAttached).toHaveBeenCalledWith("a1");
        expect(options.onFailure).not.toHaveBeenCalled();
        expect(state.text).toBe("before after");
    });

    it("does not announce the file when it was removed during the upload", async () => {
        const { options, state } = setup({ attachmentId: "a1" });

        options.attach.mockImplementation(async () => {
            state.ids = [];

            return { attachmentId: "a1" };
        });

        expect(await attachLongPaste(options)).toBe(true);
        expect(options.onAttached).not.toHaveBeenCalled();
    });

    it("writes nothing when the composer unmounted during a failed upload", async () => {
        const { options, state } = setup({ attachmentId: "a1", error: "Too big" });

        options.attach.mockImplementation(async () => {
            state.chat = null;

            return { attachmentId: "a1", error: "Too big" };
        });

        expect(await attachLongPaste(options)).toBe(false);
        expect(options.setDraft).not.toHaveBeenCalled();
        expect(options.onNotInserted).toHaveBeenCalledWith("Too big");
    });

    it("puts the text into the composer at the paste position and reports the error, not the success, when the upload failed", async () => {
        const { options, state } = setup({ attachmentId: "a1", error: "Too big" });

        expect(await attachLongPaste(options)).toBe(false);
        expect(state.text).toBe("beforePASTED after");
        expect(options.discard).toHaveBeenCalledWith("a1");
        expect(options.onFailure).toHaveBeenCalledWith("Too big");
        expect(options.onAttached).not.toHaveBeenCalled();
    });

    it("appends the text when the draft changed during the upload, instead of splitting what was typed", async () => {
        const { options, state } = setup({ attachmentId: "a1", error: "Too big" });

        options.attach.mockImplementation(async () => {
            state.text = "beforeTYPED after";

            return { attachmentId: "a1", error: "Too big" };
        });

        expect(await attachLongPaste(options)).toBe(false);
        expect(state.text).toBe("beforeTYPED afterPASTED");
        expect(options.onFailure).toHaveBeenCalledWith("Too big");
    });

    it("leaves another chat's draft alone and says the text was not inserted when the chat changed during the upload", async () => {
        const { options, state } = setup({ attachmentId: "a1", error: "Too big" });

        options.attach.mockImplementation(async () => {
            state.chat = "chat-2";
            state.text = "other chat";

            return { attachmentId: "a1", error: "Too big" };
        });

        expect(await attachLongPaste(options)).toBe(false);
        expect(state.text).toBe("other chat");
        expect(options.setDraft).not.toHaveBeenCalled();
        expect(options.discard).toHaveBeenCalledWith("a1");
        expect(options.onNotInserted).toHaveBeenCalledWith("Too big");
        expect(options.onFailure).not.toHaveBeenCalled();
    });

    it("replaces a selection and clamps an offset past the end", () => {
        expect(insertPastedText("hello world", "X", 0, 5)).toBe("X world");
        expect(insertPastedText("abc", "X", 99, 99)).toBe("abcX");
    });
});

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

describe(pasteHasText, () => {
    const clipboard = (plain: string, html = "") => {
        const formats: Record<string, string> = { "text/html": html, "text/plain": plain };

        return { getData: (type: string) => formats[type] ?? "" };
    };
    const picture = [{ name: "image.png" }];

    it.each([
        ["text from an Office app, with a picture of it", "Q3 revenue\nup 12%", picture, true],
        ["files alone", "", picture, false],
        ["a file manager's copy, whose text is the files' names", "report.pdf\nnotes.txt", [{ name: "report.pdf" }, { name: "notes.txt" }], false],
        ["a copy that names the files by path", "/Users/me/report.pdf", [{ name: "report.pdf" }], false],
        ["a file manager's copy as file URIs", "file:///home/me/My%20Report.pdf", [{ name: "My Report.pdf" }], false],
        ["a browser's image copy, whose text is the image's URL", "https://cdn.example.com/p/photo.jpg?w=800", picture, false, '<img src="https://cdn.example.com/p/photo.jpg?w=800">'],
        [
            "a browser's image copy on Windows, whose HTML is wrapped",
            "https://cdn.example.com/p/photo.jpg",
            picture,
            false,
            '<html>\r\n<body>\r\n<!--StartFragment--><img src="https://cdn.example.com/p/photo.jpg"><!--EndFragment-->\r\n</body>\r\n</html>',
        ],
        ["a picture copied out of Word, with an HTML document and no text", "\r\n", picture, false, '<html><head><style>p{}</style></head><body><p class=MsoNormal><img src="clip.png"></p></body></html>'],
        // Many comments in a row, then text: a pattern that could read the comments more than one way would hang here.
        ["copied page text after many empty markup comments", "words", picture, true, `${"<!-- -->".repeat(40)}<p>words</p>`],
        ["copied text that happens to match the picture's name", "notes.txt", [{ name: "notes.txt" }], true, "<p>notes.txt</p>"],
        ["a spreadsheet's copied links, next to a picture of the cells", "https://a.example\nhttps://b.example", picture, true, "<table><tr><td>https://a.example</td></tr></table>"],
    ])("%s: %s", (_label, plain, files, expected, html = "") => {
        expect(pasteHasText(clipboard(plain, html), files)).toBe(expected);
    });
});
