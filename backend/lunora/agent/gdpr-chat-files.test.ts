/**
 * The GDPR export carries the chat files the user holds a grant for: their uploads and generated images, metadata only. Another user's
 * file never appears, and a grant whose file is gone is left out. Past one page, every page is read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addFile } from "./files";
import { collectAllChatFiles } from "./export-pages";
import { CHAT_FILE_EXPORT_PAGE, collectChatFilesForExport } from "./gdpr";

const A = "user-a";
const B = "user-b";
const MANY = CHAT_FILE_EXPORT_PAGE + 30;
const EXPORT_FILE_CHAT_FILES = /generateExportFile[\s\S]*chatFiles,/u;

type Harness = ReturnType<typeof lunoraTest>;
interface ExportedFile {
    createdAt: number;
    filename?: string;
    hash: string;
    id: string;
    mediaType: string;
}

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

/** Stores a file the way a generated image or an upload is stored: a row, and the grant of the user who stored it. */
const store = async (userId: string, filename: string, hash: string): Promise<string> => {
    const { fileId } = (await harness.run(
        async (ctx: any) => await ctx.runMutation(addFile, { filename, hash, mediaType: "image/png", storageId: `agent-files/${hash}`, userId }),
    )) as { fileId: string };

    return fileId;
};

/** Every page of the user's export, each read by its own call (as the workflow reads them). */
const exportedFor = async (userId: string): Promise<{ files: ExportedFile[]; pages: number }> => {
    let pages = 0;
    const files = (await collectAllChatFiles(async (cursor) => {
        pages += 1;

        return await harness.run(async (ctx: any) => await ctx.runQuery(collectChatFilesForExport, { cursor, userId }));
    })) as ExportedFile[];

    return { files, pages };
};

describe("chat files in the GDPR export", () => {
    it("includes a generated image the user holds a grant for, with its metadata, and leaves out another user's", async () => {
        const generated = await store(A, "generated-1.png", "hash-generated");
        const others = await store(B, "others.png", "hash-others");

        const { files } = await exportedFor(A);
        const ids = files.map((file) => file.id);

        expect(ids).toContain(generated);
        expect(ids).not.toContain(others);
        expect(files.find((file) => file.id === generated)).toEqual({
            createdAt: expect.any(Number),
            filename: "generated-1.png",
            hash: "hash-generated",
            id: generated,
            mediaType: "image/png",
        });
    });

    it("leaves out a grant whose file row is gone", async () => {
        const gone = await store(A, "gone.png", "hash-gone");

        await harness.run(async (ctx: any) => await ctx.db.delete("chatFiles", gone));

        const { files } = await exportedFor(A);

        expect(files.map((file) => file.id)).not.toContain(gone);
    });

    it("reads every page of a user's files", async () => {
        for (let index = 0; index < MANY; index += 1) {
            await store(A, `image-${String(index)}.png`, `hash-${String(index)}`);
        }

        const { files, pages } = await exportedFor(A);

        expect(files).toHaveLength(MANY);
        expect(pages).toBeGreaterThan(1);
    });

    it("is wired into the export workflow and the export file", () => {
        const workflow = readFileSync(join(import.meta.dirname, "../gdpr/workflows/export-workflow.ts"), "utf8");
        const steps = readFileSync(join(import.meta.dirname, "../gdpr/steps.ts"), "utf8");

        expect(workflow).toContain("internal.agent.gdpr.collectChatFilesForExport");
        expect(workflow).toMatch(EXPORT_FILE_CHAT_FILES);
        expect(steps).toContain("chatFiles: args.chatFiles ?? []");
    });
});
