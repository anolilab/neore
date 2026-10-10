import { describe, expect, it, vi } from "vitest";

import { decodeDataUrl, extractComposerRestorePayload, onComposerRestore, requestComposerRestore, restoreFileName } from "./composer-restore";

describe(extractComposerRestorePayload, () => {
    it("collects text and file parts", () => {
        expect(
            extractComposerRestorePayload({
                parts: [
                    { text: "look at this", type: "text" },
                    { filename: "a.png", mediaType: "image/png", type: "file", url: "https://x/a.png" },
                    { type: "file" },
                ],
            }),
        ).toStrictEqual({ files: [{ filename: "a.png", mediaType: "image/png", url: "https://x/a.png" }], text: "look at this" });
    });

    it("prefers message.text when present", () => {
        expect(extractComposerRestorePayload({ parts: [{ text: "part", type: "text" }], text: "whole" }).text).toBe("whole");
    });
});

describe(restoreFileName, () => {
    it("keeps the original name or derives one from the media type", () => {
        expect(restoreFileName({ filename: "doc.pdf", mediaType: "application/pdf", url: "" }, 0)).toBe("doc.pdf");
        expect(restoreFileName({ mediaType: "image/jpeg", url: "" }, 1)).toBe("attachment-2.jpg");
        expect(restoreFileName({ mediaType: "application/x-thing", url: "" }, 0)).toBe("attachment-1.xthing");
    });
});

describe(decodeDataUrl, () => {
    it("decodes base64 and percent-encoded data URLs", async () => {
        const base64 = decodeDataUrl("data:text/plain;base64,aGVsbG8=");

        expect(base64?.type).toBe("text/plain");
        await expect(base64?.text()).resolves.toBe("hello");

        const plain = decodeDataUrl("data:text/plain;charset=utf-8,a%20b");

        await expect(plain?.text()).resolves.toBe("a b");
    });

    it("returns null for non-data URLs", () => {
        expect(decodeDataUrl("https://example.com/x.png")).toBeNull();
    });
});

describe("restore event bridge", () => {
    it("delivers the payload to subscribers until unsubscribed", () => {
        const handler = vi.fn();
        const unsubscribe = onComposerRestore(handler);
        const payload = { files: [], text: "again" };

        requestComposerRestore(payload);
        unsubscribe();
        requestComposerRestore(payload);

        expect(handler).toHaveBeenCalledOnce();
        expect(handler).toHaveBeenCalledWith(payload);
    });
});

describe("page context", () => {
    it("restores only the typed text, not an attached web page", () => {
        const payload = extractComposerRestorePayload({
            parts: [
                {
                    providerMetadata: { neore: { pageContext: { kind: "page", title: "Docs", url: "https://example.com" } } },
                    text: "[Web page context]\n<web_page>{}</web_page>",
                    type: "text",
                },
                { text: "Summarize this", type: "text" },
            ],
            text: "[Web page context]\n<web_page>{}</web_page>\nSummarize this",
        });

        expect(payload.text).toBe("Summarize this");
    });

    it("keeps message.text for messages without the marker", () => {
        expect(extractComposerRestorePayload({ parts: [{ text: "a", type: "text" }], text: "a" }).text).toBe("a");
    });
});
