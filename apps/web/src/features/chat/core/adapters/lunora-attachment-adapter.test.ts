import { api } from "@neore/backend/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UploadFailedError } from "@/lib/upload/upload-error";

import {
    attachmentContentType,
    attachmentSizeLimit,
    AttachmentTooLargeError,
    AttachmentUploadError,
    createLunoraAttachmentAdapter,
    uploadChatAttachment,
} from "./lunora-attachment-adapter";

const { uploadFile } = vi.hoisted(() => {
    return { uploadFile: vi.fn() };
});

vi.mock(import("@/lib/upload/upload-file"), () => {
    return { uploadFile };
});

const MB = 1024 * 1024;
const UPLOAD_ID = "upload-1";

/** A Lunora client whose finalize action answers like the backend. */
const client = (overrides: { finalize?: () => Promise<unknown> } = {}) => {
    const action = vi.fn(async (reference: unknown) => {
        if (reference === api.file.finalizeChatUpload) {
            return await (overrides.finalize?.() ?? { fileId: "file-1", url: "http://localhost:8788/agent-files/h?sig=r" });
        }

        throw new Error("unexpected action");
    });

    return { action, lunora: { action } as never };
};

const serverError = (code: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(code), { data: { code, ...extra } });

beforeEach(() => {
    uploadFile.mockReset();
    uploadFile.mockImplementation(async (_file: File, options: { onProgress?: (percent: number) => void }) => {
        options.onProgress?.(50);
        options.onProgress?.(100);

        return UPLOAD_ID;
    });
});

describe(uploadChatAttachment, () => {
    it("uploads the bytes to the upload route with progress, then finalizes the upload id", async () => {
        const { action, lunora } = client();
        const file = new File(["%PDF-1.7"], "report.pdf", { type: "application/pdf" });
        const progress: number[] = [];

        await expect(
            uploadChatAttachment(lunora, file, {
                onProgress: (percent) => {
                    progress.push(percent);
                },
            }),
        ).resolves.toStrictEqual({
            fileId: "file-1",
            url: expect.any(String),
        });

        expect(uploadFile).toHaveBeenCalledWith(file, expect.objectContaining({ contentType: "application/pdf" }));
        expect(action).toHaveBeenCalledOnce();
        expect(action).toHaveBeenCalledWith(api.file.finalizeChatUpload, { filename: "report.pdf", uploadId: UPLOAD_ID });
        // The transfer fills the bar to 95%; finalize is the rest.
        expect(progress).toStrictEqual([48, 95]);
    });

    it("never sends the bytes through an RPC", async () => {
        const { action, lunora } = client();

        await uploadChatAttachment(lunora, new File(["x".repeat(2 * MB)], "big.txt", { type: "text/plain" }));

        for (const [, args] of action.mock.calls as unknown as [unknown, Record<string, unknown>][]) {
            expect(Object.values(args).some((value) => value instanceof ArrayBuffer || value instanceof Blob)).toBe(false);
        }
    });

    it.each([
        [new UploadFailedError("expired", 404), AttachmentUploadError, "expired"],
        [new UploadFailedError("unsupported", 415), AttachmentUploadError, "unsupported"],
        [new UploadFailedError("network", 0), AttachmentUploadError, "failed"],
        [new UploadFailedError("rejected", 500), AttachmentUploadError, "failed"],
    ])("words a failed upload (%s)", async (failure, type, reason) => {
        uploadFile.mockRejectedValueOnce(failure);

        const error = await uploadChatAttachment(client().lunora, new File(["x"], "a.pdf", { type: "application/pdf" })).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(type);
        expect(error).toMatchObject({ fileName: "a.pdf", reason });
    });

    it("turns a 413 from the upload route into the too-large error with the kind's limit", async () => {
        uploadFile.mockRejectedValueOnce(new UploadFailedError("too-large", 413));

        const error = await uploadChatAttachment(client().lunora, new File(["x"], "a.pdf", { type: "application/pdf" })).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AttachmentTooLargeError);
        expect(error).toMatchObject({ isDocument: true, maxMegabytes: 25 });
    });

    it.each([
        ["CHAT_UPLOAD_EXPIRED", "expired"],
        ["CHAT_UPLOAD_UNSUPPORTED_TYPE", "unsupported"],
        ["CHAT_UPLOAD_CONTENT_MISMATCH", "content-mismatch"],
    ])("words the backend's %s", async (code, reason) => {
        const { lunora } = client({
            finalize: async () => {
                throw serverError(code);
            },
        });
        const error = await uploadChatAttachment(lunora, new File(["x"], "a.pdf", { type: "application/pdf" })).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AttachmentUploadError);
        expect(error).toMatchObject({ reason });
    });

    it("words the backend's too-large refusal with the limit it names", async () => {
        const { lunora } = client({
            finalize: async () => {
                throw serverError("CHAT_UPLOAD_TOO_LARGE", { maxBytes: 20 * MB });
            },
        });
        const error = await uploadChatAttachment(lunora, new File(["x"], "a.png", { type: "image/png" })).catch((error_: unknown) => error_);

        expect(error).toBeInstanceOf(AttachmentTooLargeError);
        expect(error).toMatchObject({ isDocument: false, maxMegabytes: 20 });
    });
});

describe(createLunoraAttachmentAdapter, () => {
    it("refuses an oversized document before uploading anything", async () => {
        const { action, lunora } = client();
        const adapter = createLunoraAttachmentAdapter(lunora);
        const file = new File(["x"], "huge.pdf", { type: "application/pdf" });

        Object.defineProperty(file, "size", { value: 25 * MB + 1 });

        await expect(adapter.upload({ file })).rejects.toBeInstanceOf(AttachmentTooLargeError);
        expect(uploadFile).not.toHaveBeenCalled();
        expect(action).not.toHaveBeenCalled();
    });

    it("refuses a type it does not attach, as a typed error", async () => {
        const adapter = createLunoraAttachmentAdapter(client().lunora);

        await expect(adapter.upload({ file: new File(["x"], "a.exe", { type: "application/x-msdownload" }) })).rejects.toMatchObject({ reason: "unsupported" });
    });

    it("passes progress through and returns the file id", async () => {
        const adapter = createLunoraAttachmentAdapter(client().lunora);
        const progress: number[] = [];
        const result = await adapter.upload({
            file: new File(["%PDF-1.7"], "r.pdf", { type: "application/pdf" }),
            onProgress: (p) => {
                progress.push(p);
            },
        });

        expect(result.metadata?.fileId).toBe("file-1");
        expect(progress.at(-1)).toBe(95);
    });
});

describe(attachmentContentType, () => {
    it.each([
        [{ name: "notes.md", type: "" }, "text/markdown"],
        [{ name: "a.TXT", type: "" }, "text/plain"],
        [{ name: "a.docx", type: "" }, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
        [{ name: "a.bin", type: "" }, "application/octet-stream"],
        [{ name: "a.pdf", type: "application/pdf" }, "application/pdf"],
    ])("%o is uploaded as %s", (file, expected) => {
        expect(attachmentContentType(file)).toBe(expected);
    });

    it("sizes a document by the backend's 25 MB rule", () => {
        expect(attachmentSizeLimit({ name: "a.pdf", type: "application/pdf" })).toStrictEqual({ isDocument: true, maxBytes: 25 * MB });
        expect(attachmentSizeLimit({ name: "a.png", type: "image/png" })).toStrictEqual({ isDocument: false, maxBytes: 20 * MB });
    });
});
