/**
 * The file-to-chat links the lock gate reads (`chatFileThreads`), written by the
 * real message writers: a send, a collaborator's send into the owner's chat, an
 * edit, a fork. A link must name the thread OWNER, whoever wrote the row.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { addMessagesHandler, cloneMessageBatch, updateMessage } from "./messages";
import { deleteChatFileLinksForThread, fileGatedByLockedChat } from "./files";
import { eraseChatFileThreadsForUser } from "./gdpr";

const OWNER = "owner-links";
const COLLABORATOR = "collaborator-links";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;
let threadId: string;
let fileId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const newThread = async (userId: string, lockedAt?: number) =>
    await run(async (ctx) => {
        const id = await ctx.db.insert("threads", { status: "active", title: "T", userId, ...(lockedAt !== undefined && { lockedAt }) });

        if (lockedAt !== undefined) {
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: "unused-by-proofs",
                iterations: 1000,
                salt: "unused-by-proofs",
                threadId: id,
                updatedAt: 1,
                userId,
            });
        }

        return id as string;
    });

const newFile = async (hash: string) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("chatFiles", {
                extractionStatus: "pending",
                filename: `${hash}.txt`,
                hash,
                lastTouchedAt: 1,
                mediaType: "text/plain",
                refcount: 0,
                storageId: `storage-${hash}`,
            }),
    );

const linksOf = async (where: { threadId?: string; userId?: string }) =>
    await run(async (ctx) => {
        if (where.threadId) {
            return await ctx.db
                .query("chatFileThreads")
                .withIndex("by_threadId", (q: any) => q.eq("threadId", where.threadId))
                .collect();
        }

        return await ctx.db
            .query("chatFileThreads")
            .withIndex("by_userId", (q: any) => q.eq("userId", where.userId))
            .collect();
    });

const send = async (userId: string, targetThreadId: string, files: string[]) =>
    await run(
        async (ctx) =>
            await addMessagesHandler(ctx, {
                messages: [{ fileIds: files, message: { content: [{ text: "see", type: "text" }], role: "user" }, status: "success" } as never],
                threadId: targetThreadId as never,
                userId,
            }),
    );

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();
    threadId = await newThread(OWNER);
    fileId = await newFile("links-1");
});

describe("chatFileThreads is written by the message writers", () => {
    it("a send with an attachment links the file to the chat, under the owner", async () => {
        await send(OWNER, threadId, [fileId]);

        await expect(linksOf({ threadId })).resolves.toMatchObject([{ fileId, threadId, userId: OWNER }]);
    });

    it("a collaborator's send into the owner's chat links under the OWNER, not the author", async () => {
        await send(COLLABORATOR, threadId, [fileId]);

        await expect(linksOf({ userId: OWNER })).resolves.toMatchObject([{ fileId, threadId, userId: OWNER }]);
        await expect(linksOf({ userId: COLLABORATOR })).resolves.toStrictEqual([]);
    });

    it("a second send of the same file to the same chat adds no second link", async () => {
        await send(OWNER, threadId, [fileId]);
        await send(OWNER, threadId, [fileId]);

        await expect(linksOf({ threadId })).resolves.toHaveLength(1);
    });

    it("an edit that adds a file links it", async () => {
        const sent = await send(OWNER, threadId, []);
        const messageId = sent?.messages[0]?._id;
        const other = await newFile("links-2");

        await run(async (ctx) => await ctx.runMutation(updateMessage, { messageId, patch: { fileIds: [other] } }));

        await expect(linksOf({ threadId })).resolves.toMatchObject([{ fileId: other, threadId }]);
    });

    it("a fork copies its files onto the new chat's links", async () => {
        await send(OWNER, threadId, [fileId]);
        const copy = await newThread(OWNER);

        await run(
            async (ctx) =>
                await ctx.runMutation(cloneMessageBatch, {
                    paginationOpts: { cursor: null, numItems: 100 },
                    sourceThreadId: threadId,
                    statuses: ["success"],
                    targetThreadId: copy,
                }),
        );

        await expect(linksOf({ threadId: copy })).resolves.toMatchObject([{ fileId, threadId: copy, userId: OWNER }]);
    });
});

describe("the links drive the lock gate", () => {
    it("gates a file sent into a chat that is later locked, and nothing else", async () => {
        const locked = await newThread(OWNER, 2);
        const other = await newFile("links-other");

        await send(OWNER, locked, [fileId]);

        await expect(run(async (ctx) => await fileGatedByLockedChat(ctx, { fileId: fileId as never, userId: OWNER }))).resolves.toBe(true);
        await expect(run(async (ctx) => await fileGatedByLockedChat(ctx, { fileId: other as never, userId: OWNER }))).resolves.toBe(false);
    });

    it("permanent thread delete drops that chat's links only", async () => {
        const gone = await newThread(OWNER);
        const other = await newFile("links-kept");

        await send(OWNER, gone, [fileId]);
        await send(OWNER, threadId, [other]);

        await run(async (ctx) => await deleteChatFileLinksForThread(ctx, gone as never));

        await expect(linksOf({ threadId: gone })).resolves.toStrictEqual([]);
        await expect(linksOf({ threadId })).resolves.toHaveLength(1);
    });

    it("account erasure drops the owner's links", async () => {
        await send(OWNER, threadId, [fileId]);

        await run(async (ctx) => await eraseChatFileThreadsForUser(ctx, OWNER));

        await expect(linksOf({ userId: OWNER })).resolves.toStrictEqual([]);
    });
});
