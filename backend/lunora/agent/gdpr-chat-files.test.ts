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
import { addFile, useExistingFile } from "./files";
import {
    CHAT_FILE_EXPORT_BYTES,
    CHAT_FILE_METADATA_CHUNK,
    CHAT_FILE_METADATA_MAX_QUERIES,
    type IdsPage,
    capChatFiles,
    chatFileMeter,
    chatFileSectionBudget,
    collectAllChatFileMetadata,
    collectAllMessageFileIds,
    textBytes,
    walkIds,
    withChatFiles,
} from "./export-pages";
import {
    CHAT_FILE_EXPORT_PAGE,
    CHAT_FILE_HASH_MAX,
    CHAT_FILE_NAME_MAX,
    chatFileMetadataForExport,
    collectGrantedChatFileIdsForExport,
    collectMessageFileIdsForExport,
    collectThreadIdsForExport,
} from "./gdpr";
import { ACTION_READ_BYTES, CHAT_FILES_READ_BYTES, READ_MARGIN_BYTES, chatFilesReadBudget } from "../gdpr/read-budget";

const A = "user-a";
const B = "user-b";
const MANY = CHAT_FILE_EXPORT_PAGE + 30;

/** The `chatFiles` section as the export writes it: its key and value, at the export's indentation. */
const sectionBytes = (chatFiles: unknown): number => {
    const text = JSON.stringify({ chatFiles }, null, 2);

    // The export object's own braces wrap the section: `{` and the `\n}` closing it are not the section's.
    return new TextEncoder().encode(text.slice(text.indexOf('"chatFiles"'), -2)).byteLength;
};

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
const bareFile = async (ctx: any, hash: string): Promise<string> => {
    const fileId = await ctx.db.insert("chatFiles", {
        extractionStatus: "pending",
        filename: `${hash}.png`,
        hash,
        lastTouchedAt: 1,
        mediaType: "image/png",
        refcount: 1,
        storageId: `agent-files/${hash}`,
    });

    // The export's view of the file, written with it, as `addFile` writes it.
    await ctx.db.insert("chatFileMetadata", { createdAt: 1, fileId, filename: `${hash}.png`, hash, mediaType: "image/png" });

    return fileId;
};

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
        async (meter) =>
            await walkIds(async (cursor) => {
                pages += 1;

                return (await harness.run(async (ctx: any) => await ctx.runQuery(collectGrantedChatFileIdsForExport, { cursor, userId }))) as IdsPage;
            }, meter),
        async (meter) =>
            await collectAllMessageFileIds(
                async (cursor) => (await harness.run(async (ctx: any) => await ctx.runQuery(collectThreadIdsForExport, { cursor, userId }))) as IdsPage,
                async (threadId, cursor) =>
                    (await harness.run(
                        async (ctx: any) => await ctx.runQuery(collectMessageFileIdsForExport, { cursor, threadId: threadId as never }),
                    )) as IdsPage,
                meter,
            ),
        async (fileIds) => await harness.run(async (ctx: any) => await ctx.runQuery(chatFileMetadataForExport, { fileIds })),
        CHAT_FILE_METADATA_CHUNK,
        chatFileMeter(),
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

        // Erased as the reaper erases a file: its metadata and its row, in one mutation.
        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.chatFileMetadata.findMany({ where: { fileId: gone } });

            await Promise.all(page.map(async (row: any) => await ctx.db.delete("chatFileMetadata", row._id)));
            await ctx.db.delete("chatFiles", gone);
        });

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

    it("cuts a hash past its limit, so one row cannot outgrow a page", async () => {
        const longHashFile = await store(A, "long-hash.png", "h".repeat(CHAT_FILE_HASH_MAX + 40));

        const { files } = await exportedFor(A);

        expect(files.find((file) => file.id === longHashFile)?.hash).toHaveLength(CHAT_FILE_HASH_MAX);
    });

    it("completes the export's view of a file whose metadata write did not land, on the next store of the same bytes", async () => {
        const fileId = await store(A, "retried.png", "hash-retried");
        const storedAt = (await harness.run(async (ctx: any) => {
            const file = await ctx.db.chatFiles.findFirst({ where: { _id: fileId } });

            return file._creationTime;
        })) as number;

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.chatFileMetadata.findMany({ where: { fileId } });

            await Promise.all(page.map(async (row: any) => await ctx.db.delete("chatFileMetadata", row._id)));
        });
        const before = await exportedFor(A);

        expect(before.files.map((file) => file.id)).not.toContain(fileId);

        await store(A, "retried.png", "hash-retried");

        const after = await exportedFor(A);

        expect(after.files.map((file) => file.id)).toContain(fileId);
        // Dated as the file was stored, not as it was repaired.
        expect(after.files.find((file) => file.id === fileId)?.createdAt).toBe(storedAt);
    });

    it("repairs the export's view of a file on the reuse path, as a store of the same bytes does", async () => {
        const fileId = await store(A, "reused.png", "hash-reused");

        await harness.run(async (ctx: any) => {
            const { page } = await ctx.db.chatFileMetadata.findMany({ where: { fileId } });

            await Promise.all(page.map(async (row: any) => await ctx.db.delete("chatFileMetadata", row._id)));
        });

        // The client's store of bytes the workspace already holds takes this path (`agent/client/files.ts`).
        await harness.run(async (ctx: any) => await ctx.runMutation(useExistingFile, { filename: "reused.png", hash: "hash-reused", userId: A }));

        const after = await exportedFor(A);

        expect(after.files.map((file) => file.id)).toContain(fileId);
    });

    it("lists a file once when two stores of the same bytes each wrote its metadata", async () => {
        const fileId = await store(A, "twice.png", "hash-twice");

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("chatFileMetadata", { createdAt: 1, fileId, filename: "twice.png", hash: "hash-twice", mediaType: "image/png" });
        });

        const { files } = await exportedFor(A);

        expect(files.filter((file) => file.id === fileId)).toHaveLength(1);
    });

    it("reads the metadata, not the file row, so a large extracted text is not read", async () => {
        const fileId = await store(A, "documented.png", "hash-documented");

        await harness.run(async (ctx: any) => await ctx.db.patch("chatFiles", fileId, { extractedText: "x".repeat(200_000) }));

        const read = (await harness.run(async (ctx: any) => await ctx.runQuery(chatFileMetadataForExport, { fileIds: [fileId] }))) as {
            readBytes: number;
            rows: unknown[];
        };

        expect(read.rows).toHaveLength(1);
        expect(read.readBytes).toBeLessThan(10_000);
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
            async (meter) => await walkIds(async (cursor) => grantPages[cursor ?? ""] ?? { cursor: null, ids: [] }, meter),
            async () => {
                return { ids: ["d", "a"], readBytes: 0, truncated: false };
            },
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

        // The granted ids are read first (a, b, then c); the message ids come after, without the ones already read.
        expect(reads).toEqual([["a", "b"], ["c"], ["d"]]);
        expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("stops reading once the read budget is spent, and says so", async () => {
        const reads: string[][] = [];

        const { rows, truncated } = await collectAllChatFileMetadata(
            async (meter) =>
                await walkIds(async () => {
                    return { cursor: null, ids: ["a", "b", "c", "d", "e", "f"] };
                }, meter),
            async () => {
                return { ids: [], readBytes: 0, truncated: false };
            },
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
            chatFileMeter(15),
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

        const { ids } = await collectAllMessageFileIds(
            async (cursor) => threadPages[cursor ?? ""] ?? { cursor: null, ids: [] },
            async (threadId, cursor) => messagePages[`${threadId}:${cursor ?? ""}`] ?? { cursor: null, ids: [] },
            chatFileMeter(),
        );

        expect(ids).toEqual(["x", "y", "z"]);
    });

    it("stops a walk once the bytes its pages read reach the budget, and says so", async () => {
        const pages: Record<string, IdsPage> = {
            "": { cursor: "p1", ids: ["a"], readBytes: 10 },
            p1: { cursor: "p2", ids: ["b"], readBytes: 10 },
            p2: { cursor: null, ids: ["c"], readBytes: 10 },
        };

        expect(await walkIds(async (cursor) => pages[cursor ?? ""] ?? { cursor: null, ids: [] }, chatFileMeter(15))).toEqual({
            ids: ["a", "b"],
            readBytes: 20,
            truncated: true,
        });
        expect(await walkIds(async (cursor) => pages[cursor ?? ""] ?? { cursor: null, ids: [] }, chatFileMeter(100))).toEqual({
            ids: ["a", "b", "c"],
            readBytes: 30,
            truncated: false,
        });
    });

    it("gives the message walk what the grants left of the budget, and stops in the threads that follow once it is spent", async () => {
        const messageReads: string[] = [];

        const walked = await collectAllMessageFileIds(
            async () => {
                return { cursor: null, ids: ["t1", "t2", "t3"] };
            },
            async (threadId) => {
                messageReads.push(threadId);

                return { cursor: null, ids: [threadId], readBytes: 10 };
            },
            chatFileMeter(15),
        );

        // Thread t1 reads 10 bytes, t2 reads 10 more (past 15): t3 is not read, and the walk says it stopped short.
        expect(messageReads).toEqual(["t1", "t2"]);
        expect(walked).toEqual({ ids: ["t1", "t2"], readBytes: 20, truncated: true });
    });

    it("stops a walk once its query allowance is spent, and says so", async () => {
        const pages: Record<string, IdsPage> = {
            "": { cursor: "p1", ids: ["a"] },
            p1: { cursor: "p2", ids: ["b"] },
            p2: { cursor: null, ids: ["c"] },
        };

        expect(await walkIds(async (cursor) => pages[cursor ?? ""] ?? { cursor: null, ids: [] }, chatFileMeter(Infinity, 2))).toEqual({
            ids: ["a", "b"],
            readBytes: 0,
            truncated: true,
        });
    });

    it("stops reading metadata chunks once their own query allowance is spent, and says so", async () => {
        const granted = Array.from({ length: CHAT_FILE_METADATA_MAX_QUERIES + 5 }, (_, index) => `g${String(index)}`);

        const { rows, truncated } = await collectAllChatFileMetadata(
            async (meter) =>
                await walkIds(async () => {
                    return { cursor: null, ids: granted };
                }, meter),
            async () => {
                return { ids: [], readBytes: 0, truncated: false };
            },
            async (fileIds) => {
                return {
                    readBytes: 0,
                    rows: fileIds.map((id) => {
                        return { id };
                    }),
                };
            },
            1,
            chatFileMeter(),
        );

        expect(rows).toHaveLength(CHAT_FILE_METADATA_MAX_QUERIES);
        expect(truncated).toBe(true);
    });

    it("reads the granted files' metadata before a long message history spends the allowance", async () => {
        const { rows, truncated } = await collectAllChatFileMetadata(
            async (meter) =>
                await walkIds(async () => {
                    return { cursor: null, ids: ["granted"] };
                }, meter),
            async (meter) => {
                // The message walk spends what is left of the bytes, as a long history does.
                meter.bytesLeft = 0;

                return { ids: ["message-only"], readBytes: 0, truncated: true };
            },
            async (fileIds) => {
                return {
                    readBytes: 10,
                    rows: fileIds.map((id) => {
                        return { id };
                    }),
                };
            },
            CHAT_FILE_METADATA_CHUNK,
            chatFileMeter(20),
        );

        // The reserve keeps the walk from taking the metadata reads: the file it found before running long is read too.
        expect(rows.map((row) => row.id)).toEqual(["granted", "message-only"]);
        expect(truncated).toBe(true);
    });

    it("keeps the rows whose section, as the export writes it, fits the budget, and flags the cut", () => {
        const rows = [{ id: "a".repeat(40) }, { id: "b".repeat(40) }, { id: "c".repeat(40) }];

        expect(capChatFiles(rows, 10_000)).toEqual({ files: rows, truncated: false });

        for (const budget of [1000, 400, 300, 100]) {
            const cut = capChatFiles(rows, budget);

            expect(sectionBytes({ files: cut.files, truncated: cut.truncated })).toBeLessThanOrEqual(budget);
            expect(cut.truncated).toBe(cut.files.length < rows.length);
            expect(cut.files).toEqual(rows.slice(0, cut.files.length));
        }
    });

    it("keeps a row that fits the section's budget exactly, and cuts the first one that does not", () => {
        const rows = [{ id: "a".repeat(40) }, { id: "b".repeat(40) }, { id: "c".repeat(40) }];

        for (const count of [1, 2, 3]) {
            const exact = sectionBytes({ files: rows.slice(0, count), truncated: false });

            expect(capChatFiles(rows, exact).files).toHaveLength(count);
            expect(capChatFiles(rows, exact - 1).files).toHaveLength(count - 1);
        }
    });

    it("counts a row as the export writes it, with the nested rows' own lines and the section's frame", () => {
        // Rows with nested objects and multi-byte text: their written size is larger than their compact JSON.
        const rows = Array.from({ length: 40 }, (_, index) => {
            return { filename: `ünïcode-${String(index)}.png`, meta: { tags: ["a", "b"] } };
        });

        for (const budget of [2000, 5000, 9000]) {
            const cut = capChatFiles(rows, budget);

            expect(sectionBytes({ files: cut.files, truncated: cut.truncated })).toBeLessThanOrEqual(budget);
        }
    });

    it("gives the chat-file metadata what the sections before it left of the action's read budget", () => {
        expect(chatFilesReadBudget(0)).toBe(CHAT_FILES_READ_BYTES);
        expect(chatFilesReadBudget(ACTION_READ_BYTES)).toBe(0);
        expect(chatFilesReadBudget(ACTION_READ_BYTES - READ_MARGIN_BYTES - 1024)).toBe(1024);
    });

    it("gives the chat-file section what the rest of the export leaves under the file's size limit", () => {
        expect(chatFileSectionBudget(100, 1000)).toBe(1000 - 100 - 64);
        expect(chatFileSectionBudget(2000, 1000)).toBe(0);
        expect(chatFileSectionBudget(0, 1_000_000_000)).toBe(CHAT_FILE_EXPORT_BYTES);
    });

    it("writes the chat-file section as the export's last key, and the file still parses", () => {
        const rest = JSON.stringify({ a: 1, nested: { b: [1, 2] } }, null, 2);
        const chatFiles = { files: [{ filename: "n.png", id: "x" }], truncated: false };

        expect(JSON.parse(withChatFiles(rest, chatFiles))).toEqual({ a: 1, chatFiles, nested: { b: [1, 2] } });
    });

    it("keeps the whole file within its size limit, with the chat-file section cut to fit", () => {
        const rest = JSON.stringify({ padding: "p".repeat(5000) }, null, 2);
        const limit = 9000;
        const rows = Array.from({ length: 200 }, (_, index) => {
            return { filename: "f".repeat(40), id: `row-${String(index)}` };
        });

        const capped = capChatFiles(rows, chatFileSectionBudget(textBytes(rest), limit));
        const file = withChatFiles(rest, { files: capped.files, truncated: capped.truncated });

        expect(capped.truncated).toBe(true);
        expect(textBytes(file)).toBeLessThanOrEqual(limit);
    });

    it("is wired into the export action", () => {
        const steps = readFileSync(join(import.meta.dirname, "../gdpr/steps.ts"), "utf8");

        expect(steps).toContain("internal.agent.gdpr.collectGrantedChatFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectThreadIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectMessageFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.chatFileMetadataForExport");
        expect(steps).toContain("capChatFiles(chatFileRead.rows, chatFileSectionBudget(restBytes, MAX_EXPORT_BYTES))");
        expect(steps).toContain("withChatFiles(rest, chatFiles)");
        expect(steps).toContain("chatFilesReadBudget(");
    });
});
