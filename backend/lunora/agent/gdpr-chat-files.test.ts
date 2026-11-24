/**
 * The GDPR export carries the chat files of the user: the files behind their grants and the files their messages still name. Metadata
 * only. Another user's file never appears, a file named by both sources is listed once, a file whose row is gone is left out, and a
 * chat link that no message names is not exported (a link outlives the message that named the file). Past one page, every page is
 * read. A long name is cut, and a section past its byte budget is cut and flagged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addFile } from "./files";
import { type IdsPage, capChatFiles, collectAllChatFileMetadata, collectAllMessageFileIds } from "./export-pages";
import {
    CHAT_FILE_EXPORT_PAGE,
    CHAT_FILE_NAME_MAX,
    chatFileMetadataForExport,
    collectGrantedChatFileIdsForExport,
    collectMessageFileIdsForExport,
    collectThreadIdsForExport,
} from "./gdpr";

const A = "user-a";
const B = "user-b";
const MANY = CHAT_FILE_EXPORT_PAGE + 30;

type Harness = ReturnType<typeof lunoraTest>;
interface ExportedFile {
    createdAt: number;
    filename?: string;
    filenameCut: boolean;
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

/** Stores a file the way an upload is stored: a row, and the grant of the user who stored it. */
const store = async (userId: string, filename: string, hash: string): Promise<string> => {
    const { fileId } = (await harness.run(
        async (ctx: any) => await ctx.runMutation(addFile, { filename, hash, mediaType: "image/png", storageId: `agent-files/${hash}`, userId }),
    )) as { fileId: string };

    return fileId;
};

/** A bare file row, with neither a grant nor a message naming it. */
const bareFile = async (ctx: any, hash: string): Promise<string> =>
    await ctx.db.insert("chatFiles", {
        extractionStatus: "pending",
        filename: `${hash}.png`,
        hash,
        lastTouchedAt: 1,
        mediaType: "image/png",
        refcount: 1,
        storageId: `agent-files/${hash}`,
    });

/**
 * A file that one of the user's messages names, with no grant: a large part stored with a message has no owner, so the message is the
 * record of the file.
 */
const storeInMessageOnly = async (userId: string, hash: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const fileId = await bareFile(ctx, hash);
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });

        await ctx.db.insert("messages", {
            fileIds: [fileId],
            message: { content: "m", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "m",
            threadId,
            tool: false,
            userId,
        });

        return fileId;
    });

/** A message of `userId`'s chat that names an existing file. */
const messageNaming = async (userId: string, fileId: string): Promise<void> => {
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });

        await ctx.db.insert("messages", {
            fileIds: [fileId],
            message: { content: "m", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "m",
            threadId,
            tool: false,
            userId,
        });
    });
};

/** A chat link of `userId` to a file, with no message naming the file: what a deleted message leaves behind. */
const staleLinkOf = async (userId: string, hash: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const fileId = await bareFile(ctx, hash);
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });

        await ctx.db.insert("chatFileThreads", { createdAt: 1, fileId, threadId, userId });

        return fileId;
    });

/** The whole export for one user: the grants and the message files, then the metadata read, as the export action does. */
const exportedFor = async (userId: string): Promise<{ files: ExportedFile[]; pages: number }> => {
    let pages = 0;
    const read = (await collectAllChatFileMetadata(
        async (cursor) => {
            pages += 1;

            return (await harness.run(async (ctx: any) => await ctx.runQuery(collectGrantedChatFileIdsForExport, { cursor, userId }))) as IdsPage;
        },
        async () =>
            await collectAllMessageFileIds(
                async (cursor) => (await harness.run(async (ctx: any) => await ctx.runQuery(collectThreadIdsForExport, { cursor, userId }))) as IdsPage,
                async (threadId, cursor) =>
                    (await harness.run(
                        async (ctx: any) => await ctx.runQuery(collectMessageFileIdsForExport, { cursor, threadId: threadId as never }),
                    )) as IdsPage,
            ),
        async (fileIds) => await harness.run(async (ctx: any) => await ctx.runQuery(chatFileMetadataForExport, { fileIds })),
    )) as { rows: ExportedFile[]; truncated: boolean };

    return { files: read.rows, pages };
};

describe("chat files in the GDPR export", () => {
    it("includes an uploaded or generated file the user holds a grant for, with its metadata, and leaves out another user's", async () => {
        const generated = await store(A, "generated-1.png", "hash-generated");
        const others = await store(B, "others.png", "hash-others");

        const { files } = await exportedFor(A);
        const ids = files.map((file) => file.id);

        expect(ids).toContain(generated);
        expect(ids).not.toContain(others);
        expect(files.find((file) => file.id === generated)).toEqual({
            createdAt: expect.any(Number),
            filename: "generated-1.png",
            filenameCut: false,
            hash: "hash-generated",
            id: generated,
            mediaType: "image/png",
        });
    });

    it("includes a file the user's message names, with no grant, and leaves out another user's", async () => {
        const messageOnly = await storeInMessageOnly(A, "hash-message-only");
        const othersMessageOnly = await storeInMessageOnly(B, "hash-others-message-only");

        const { files } = await exportedFor(A);
        const ids = files.map((file) => file.id);

        expect(ids).toContain(messageOnly);
        expect(ids).not.toContain(othersMessageOnly);
    });

    it("leaves out a chat link that no message of the chat names", async () => {
        const stale = await staleLinkOf(A, "hash-stale");

        const { files } = await exportedFor(A);

        expect(files.map((file) => file.id)).not.toContain(stale);
    });

    it("lists a file once when a grant and a message both name it", async () => {
        const shared = await store(A, "shared.png", "hash-shared");

        await messageNaming(A, shared);

        const { files } = await exportedFor(A);

        expect(files.filter((file) => file.id === shared)).toHaveLength(1);
    });

    it("leaves out a grant whose file row is gone", async () => {
        const gone = await store(A, "gone.png", "hash-gone");

        await harness.run(async (ctx: any) => await ctx.db.delete("chatFiles", gone));

        const { files } = await exportedFor(A);

        expect(files.map((file) => file.id)).not.toContain(gone);
    });

    it("cuts a name past its limit and says so", async () => {
        const long = "n".repeat(CHAT_FILE_NAME_MAX + 40);

        const longFile = await store(A, long, "hash-long-name");

        const { files } = await exportedFor(A);
        const exported = files.find((file) => file.id === longFile);

        expect(exported?.filename).toHaveLength(CHAT_FILE_NAME_MAX);
        expect(exported?.filenameCut).toBe(true);
    });

    it("reads every page of a user's files", async () => {
        for (let index = 0; index < MANY; index += 1) {
            await store(A, `image-${String(index)}.png`, `hash-${String(index)}`);
        }

        const { files, pages } = await exportedFor(A);

        expect(files).toHaveLength(MANY);
        expect(pages).toBeGreaterThan(1);
    });

    it("walks the grants and the messages, lists each file once, and reads metadata in chunks", async () => {
        const grantPages: Record<string, IdsPage> = {
            "": { cursor: "next", ids: ["a", "b"] },
            next: { cursor: null, ids: ["c", "b"] },
        };
        const reads: string[][] = [];

        const { rows } = await collectAllChatFileMetadata(
            async (cursor) => grantPages[cursor ?? ""] ?? { cursor: null, ids: [] },
            async () => ["d", "a"],
            async (fileIds) => {
                reads.push(fileIds);

                return {
                    readBytes: 0,
                    rows: fileIds.map((id) => {
                        return { id };
                    }),
                };
            },
            2,
        );

        expect(reads).toEqual([
            ["a", "b"],
            ["c", "d"],
        ]);
        expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("stops reading once the read budget is spent, and says so", async () => {
        const reads: string[][] = [];

        const { rows, truncated } = await collectAllChatFileMetadata(
            async () => {
                return { cursor: null, ids: ["a", "b", "c", "d", "e", "f"] };
            },
            async () => [],
            async (fileIds) => {
                reads.push(fileIds);

                return {
                    readBytes: 10,
                    rows: fileIds.map((id) => {
                        return { id };
                    }),
                };
            },
            2,
            15,
        );

        // Chunks of two, ten bytes each: two chunks read (20 bytes, past 15), the third is not.
        expect(reads).toHaveLength(2);
        expect(rows).toHaveLength(4);
        expect(truncated).toBe(true);
    });

    it("walks every thread and every page of each thread's messages", async () => {
        const threadPages: Record<string, IdsPage> = {
            "": { cursor: "t2", ids: ["t1"] },
            t2: { cursor: null, ids: ["t2"] },
        };
        const messagePages: Record<string, IdsPage> = {
            "t1:": { cursor: "m2", ids: ["x"] },
            "t1:m2": { cursor: null, ids: ["y"] },
            "t2:": { cursor: null, ids: ["z"] },
        };

        const ids = await collectAllMessageFileIds(
            async (cursor) => threadPages[cursor ?? ""] ?? { cursor: null, ids: [] },
            async (threadId, cursor) => messagePages[`${threadId}:${cursor ?? ""}`] ?? { cursor: null, ids: [] },
        );

        expect(ids).toEqual(["x", "y", "z"]);
    });

    it("keeps the rows that fit the section's budget and flags the cut", () => {
        const rows = [{ id: "a".repeat(40) }, { id: "b".repeat(40) }, { id: "c".repeat(40) }];

        const fitting = capChatFiles(rows, 10_000);
        const cut = capChatFiles(rows, 100);

        expect(fitting).toEqual({ files: rows, truncated: false });
        expect(cut.truncated).toBe(true);
        expect(cut.files).toEqual(rows.slice(0, cut.files.length));
        expect(cut.files.length).toBeLessThan(rows.length);
    });

    it("is wired into the export action", () => {
        const steps = readFileSync(join(import.meta.dirname, "../gdpr/steps.ts"), "utf8");

        expect(steps).toContain("internal.agent.gdpr.collectGrantedChatFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectThreadIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectMessageFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.chatFileMetadataForExport");
        expect(steps).toContain("capChatFiles(chatFileRead.rows)");
        expect(steps).toContain("\n            chatFiles,\n");
    });
});
