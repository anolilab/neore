/**
 * The GDPR export carries the chat files of the user: the files behind their grants, the files linked to their own chats, and the files
 * their messages name (a chat from before the links and grants existed has only the last). Metadata only. Another user's file never
 * appears, a file named by several sources is listed once, and a file whose row is gone is left out. Past one page, every page is read.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { addFile } from "./files";
import { type IdsPage, collectAllChatFileMetadata, collectAllMessageFileIds } from "./export-pages";
import {
    CHAT_FILE_EXPORT_PAGE,
    chatFileMetadataForExport,
    collectChatFileIdsForExport,
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

/** A file stored with a message: the row and the link of the owner's chat, and no grant (`mapping.ts` stores large parts without one). */
const storeWithMessage = async (userId: string, hash: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });
        const fileId = await ctx.db.insert("chatFiles", {
            extractionStatus: "pending",
            filename: `${hash}.png`,
            hash,
            lastTouchedAt: 1,
            mediaType: "image/png",
            refcount: 1,
            storageId: `agent-files/${hash}`,
        });

        await ctx.db.insert("chatFileThreads", { createdAt: 1, fileId, threadId, userId });

        return fileId as string;
    });

/**
 * A file that only a message names: no grant and no link, as a chat from before either existed has it. The message is the only
 * record of the file, so the export must read the messages.
 */
const storeInMessageOnly = async (userId: string, hash: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });
        const fileId = await ctx.db.insert("chatFiles", {
            extractionStatus: "pending",
            filename: `${hash}.png`,
            hash,
            lastTouchedAt: 1,
            mediaType: "image/png",
            refcount: 1,
            storageId: `agent-files/${hash}`,
        });

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

        return fileId as string;
    });

/** Adds a chat link of `userId` to a file that already exists. */
const linkTo = async (userId: string, fileId: string): Promise<void> => {
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "T", userId });

        await ctx.db.insert("chatFileThreads", { createdAt: 1, fileId, threadId, userId });
    });
};

/** The whole export for one user: each source walked to its end, then the metadata read, as the export action does. */
const exportedFor = async (userId: string): Promise<{ files: ExportedFile[]; pages: number }> => {
    let pages = 0;
    const files = (await collectAllChatFileMetadata(
        async (source, cursor) => {
            pages += 1;

            return (await harness.run(async (ctx: any) => await ctx.runQuery(collectChatFileIdsForExport, { cursor, source, userId }))) as IdsPage;
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
    )) as ExportedFile[];

    return { files, pages };
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
            hash: "hash-generated",
            id: generated,
            mediaType: "image/png",
        });
    });

    it("includes a file linked to the user's chat, which has no grant, and leaves out another user's", async () => {
        const linked = await storeWithMessage(A, "hash-linked");
        const othersLinked = await storeWithMessage(B, "hash-others-linked");

        const { files } = await exportedFor(A);
        const ids = files.map((file) => file.id);

        expect(ids).toContain(linked);
        expect(ids).not.toContain(othersLinked);
    });

    it("includes a file that only the user's message names, with no grant and no link, and leaves out another user's", async () => {
        const messageOnly = await storeInMessageOnly(A, "hash-message-only");
        const othersMessageOnly = await storeInMessageOnly(B, "hash-others-message-only");

        const { files } = await exportedFor(A);
        const ids = files.map((file) => file.id);

        expect(ids).toContain(messageOnly);
        expect(ids).not.toContain(othersMessageOnly);
    });

    it("lists a file once when a grant and a chat link both name it", async () => {
        const shared = await store(A, "shared.png", "hash-shared");

        await linkTo(A, shared);

        const { files } = await exportedFor(A);

        expect(files.filter((file) => file.id === shared)).toHaveLength(1);
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

    it("walks every source, lists each file once, and reads metadata in chunks", async () => {
        const pages: Record<string, IdsPage[]> = {
            grants: [
                { cursor: "next", ids: ["a", "b"] },
                { cursor: null, ids: ["c"] },
            ],
            threads: [{ cursor: null, ids: ["b", "d"] }],
        };
        const reads: string[][] = [];

        const rows = await collectAllChatFileMetadata(
            async (source, cursor) => pages[source]?.[cursor === null ? 0 : 1] ?? { cursor: null, ids: [] },
            async () => ["e", "a"],
            async (fileIds) => {
                reads.push(fileIds);

                return fileIds.map((id) => {
                    return { id };
                });
            },
            2,
        );

        expect(reads).toEqual([["a", "b"], ["c", "d"], ["e"]]);
        expect(rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
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

    it("is wired into the export action", () => {
        const steps = readFileSync(join(import.meta.dirname, "../gdpr/steps.ts"), "utf8");

        expect(steps).toContain("internal.agent.gdpr.collectChatFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectThreadIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.collectMessageFileIdsForExport");
        expect(steps).toContain("internal.agent.gdpr.chatFileMetadataForExport");
        expect(steps).toContain("\n            chatFiles,\n");
    });
});
