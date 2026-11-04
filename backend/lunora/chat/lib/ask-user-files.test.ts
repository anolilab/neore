/**
 * The files an `askUser` answer carries: only files the owner may use, only
 * allowed types (images and PDFs), only within the size cap, at most the file cap; any
 * other read failure is the run's and is raised, not swallowed.
 */
import { LunoraError } from "lunorash/server";
import { describe, expect, it, vi } from "vitest";

import { ASK_USER_MAX_FILES } from "../tools/ask-user-constants";
import { answerFilesMessage, filesTheModelReads, loadAskUserFiles, withAnswerFiles } from "./ask-user-files";

const PNG_BYTES = new Uint8Array([137, 80, 78, 71]);

const fileRow = (id: string, mediaType: string, filename = `${id}.png`) => {
    return {
        _id: id,
        filename,
        hash: `hash-${id}`,
        mediaType,
        storageId: `key/${id}`,
    };
};

const objectOf = (bytes: Uint8Array) => {
    return {
        body: new Blob([bytes]).stream(),
        httpMetadata: { contentType: "image/png" },
        size: bytes.byteLength,
    };
};

/** A fake of the two surfaces the loader uses: the file lookup query and `ctx.storage`. */
const makeCtx = (files: Record<string, ReturnType<typeof fileRow> | null>, objects: Record<string, unknown>) => {
    const runQuery = vi.fn(async (_ref: unknown, args: { fileId: string }) => files[args.fileId] ?? null);
    const download = vi.fn(async (key: string) => objects[key] ?? null);

    return { ctx: { runQuery, storage: { download } } as never, download, runQuery };
};

describe("loadAskUserFiles", () => {
    it("reads an owned image as base64 with its name and type", async () => {
        const { ctx } = makeCtx({ a: fileRow("a", "image/png") }, { "key/a": objectOf(PNG_BYTES) });

        const files = await loadAskUserFiles(ctx, { fileIds: ["a"], threadId: "t1", userId: "u1" });

        expect(files).toEqual([{ data: Buffer.from(PNG_BYTES).toString("base64"), filename: "a.png", mediaType: "image/png" }]);
    });

    it("leaves out a file the owner may not use, without saying why", async () => {
        const { ctx, download } = makeCtx({}, {});

        const files = await loadAskUserFiles(ctx, { fileIds: ["someone-elses"], threadId: "t1", userId: "u1" });

        expect(files).toEqual([]);
        expect(download).not.toHaveBeenCalled();
    });

    it("leaves out an image above the provider's per-image limit, though a PDF of that size is read", async () => {
        const fourMb = new Uint8Array(4 * 1024 * 1024);
        const { ctx } = makeCtx(
            { doc: fileRow("doc", "application/pdf", "doc.pdf"), img: fileRow("img", "image/png") },
            { "key/doc": objectOf(fourMb), "key/img": objectOf(fourMb) },
        );

        const files = await loadAskUserFiles(ctx, { fileIds: ["img", "doc"], threadId: "t1", userId: "u1" });

        expect(files.map((file) => file.filename)).toEqual(["doc.pdf"]);
    });

    it("reads an owned PDF as base64", async () => {
        const { ctx } = makeCtx({ doc: fileRow("doc", "application/pdf", "doc.pdf") }, { "key/doc": objectOf(PNG_BYTES) });

        const files = await loadAskUserFiles(ctx, { fileIds: ["doc"], threadId: "t1", userId: "u1" });

        expect(files).toEqual([{ data: Buffer.from(PNG_BYTES).toString("base64"), filename: "doc.pdf", mediaType: "application/pdf" }]);
    });

    it("leaves out a file that is not an allowed type, before reading it", async () => {
        const { ctx, download } = makeCtx({ html: fileRow("html", "text/html", "page.html") }, {});

        const files = await loadAskUserFiles(ctx, { fileIds: ["html"], threadId: "t1", userId: "u1" });

        expect(files).toEqual([]);
        expect(download).not.toHaveBeenCalled();
    });

    it("leaves out a file over the size cap", async () => {
        const { ctx } = makeCtx({ big: fileRow("big", "image/png") }, { "key/big": { ...objectOf(PNG_BYTES), size: 11 * 1024 * 1024 } });

        const files = await loadAskUserFiles(ctx, { fileIds: ["big"], threadId: "t1", userId: "u1" });

        expect(files).toEqual([]);
    });

    it("reads each id once and no more than the file cap", async () => {
        const ids = Array.from({ length: ASK_USER_MAX_FILES + 2 }, (_, index) => `f${String(index)}`);
        const fileRows = Object.fromEntries(ids.map((id) => [id, fileRow(id, "image/png")]));
        const objects = Object.fromEntries(ids.map((id) => [`key/${id}`, objectOf(PNG_BYTES)]));
        const { ctx, runQuery } = makeCtx(fileRows, objects);

        const files = await loadAskUserFiles(ctx, { fileIds: [...ids, "f0"], threadId: "t1", userId: "u1" });

        expect(files).toHaveLength(ASK_USER_MAX_FILES);
        expect(runQuery).toHaveBeenCalledTimes(ASK_USER_MAX_FILES);
    });

    it("stops at the answer's total budget: a file that would exceed what is left is left out", async () => {
        const eightMb = new Uint8Array(8 * 1024 * 1024);
        const ids = ["big1", "big2", "big3"];
        const { ctx } = makeCtx(
            Object.fromEntries(ids.map((id) => [id, fileRow(id, "application/pdf", `${id}.pdf`)])),
            Object.fromEntries(ids.map((id) => [`key/${id}`, objectOf(eightMb)])),
        );

        const files = await loadAskUserFiles(ctx, { fileIds: ids, threadId: "t1", userId: "u1" });

        expect(files).toHaveLength(2);
    }, 30_000);

    it("raises a storage failure that is not a missing or oversized file", async () => {
        const ctx = {
            runQuery: vi.fn(async () => fileRow("a", "image/png")),
            storage: {
                download: vi.fn(async () => {
                    throw new LunoraError("INTERNAL", "bucket unavailable");
                }),
            },
        } as never;

        await expect(loadAskUserFiles(ctx, { fileIds: ["a"], threadId: "t1", userId: "u1" })).rejects.toThrow("bucket unavailable");
    });
});

describe("filesTheModelReads", () => {
    const image = { data: "AAAA", filename: "shot.png", mediaType: "image/png" };
    const pdf = { data: "AAAA", filename: "doc.pdf", mediaType: "application/pdf" };

    it("keeps only the kinds the run's model reads", () => {
        expect(filesTheModelReads([image, pdf], { files: false, images: false, tools: true })).toEqual([]);
        expect(filesTheModelReads([image, pdf], { files: true, images: true, tools: true })).toEqual([image, pdf]);
    });

    it("reads none of the files when the model is not in the catalogue", () => {
        expect(filesTheModelReads([image, pdf], undefined)).toEqual([]);
    });
});

describe(answerFilesMessage, () => {
    it("is nothing when no file is readable", () => {
        expect(answerFilesMessage([])).toBeUndefined();
    });

    it("sends images as image parts and PDFs as file parts, in one user message", () => {
        const message = answerFilesMessage([
            { data: "aW1n", filename: "photo.png", mediaType: "image/png" },
            { data: "cGRm", filename: "spec.pdf", mediaType: "application/pdf" },
        ]);

        expect(message?.role).toBe("user");
        expect(message?.content).toEqual([
            expect.objectContaining({ type: "text" }),
            { image: "aW1n", mediaType: "image/png", type: "image" },
            { data: "cGRm", filename: "spec.pdf", mediaType: "application/pdf", type: "file" },
        ]);
    });
});

describe(withAnswerFiles, () => {
    it("puts the files at the end of a step's messages, once", () => {
        expect(withAnswerFiles(["prompt", "tool-result"], "files")).toEqual(["prompt", "tool-result", "files"]);
    });

    it("replaces the copy a step carried from an earlier one, and keeps the other messages in order", () => {
        expect(withAnswerFiles(["prompt", "files", "steering", "tool-call"], "files")).toEqual(["prompt", "steering", "tool-call", "files"]);
    });
});
