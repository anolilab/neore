/**
 * A grant proves the caller stored the bytes, not that they may read them in
 * this chat. A file that sits in a locked chat of the caller's is that chat's
 * content: attaching it by id, with no thread or into another chat, must need
 * the locked chat's proof. Each refusal has a positive twin, so a refusal cannot
 * pass by breaking the grant path altogether.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import { mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { changeMessageFiles, getFileForUser } from "./files";

const SECRET = "test-storage-signing-secret";
const OWNER = "owner-files";

let harness: ReturnType<typeof lunoraTest>;
let lockedId: string;
let otherLockedId: string;
let openId: string;
let secretFileId: string;
let openFileId: string;
let epoch: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const insertFile = async (filename: string, hash: string) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("chatFiles", {
                extractionStatus: "pending",
                filename,
                hash,
                lastTouchedAt: 1,
                mediaType: "text/plain",
                refcount: 1,
                storageId: `storage-${hash}`,
            }),
    );

/** Attaches through the message writer, which records the chat's link to the file. */
const messageWith = async (threadId: string, fileId: string, order: number) =>
    await run(async (ctx) => {
        await ctx.db.insert("messages", {
            fileIds: [fileId],
            message: { content: "attached", role: "user" },
            order,
            status: "success",
            stepOrder: 0,
            text: "attached",
            threadId,
            tool: false,
            userId: OWNER,
        });
        await changeMessageFiles(ctx, threadId as Id<"threads">, [], [fileId as Id<"chatFiles">]);
    });

const lockedThread = async (lockedAt: number) =>
    await run(async (ctx) => {
        const threadId = await ctx.db.insert("threads", { lockedAt, status: "active", title: "Locked", userId: OWNER });

        await ctx.db.insert("threadPasscodes", {
            createdAt: 1,
            epoch,
            failedAttempts: 0,
            hash: "unused-by-proofs",
            iterations: 1000,
            salt: "unused-by-proofs",
            threadId,
            updatedAt: 1,
            userId: OWNER,
        });

        return threadId;
    });

const proofFor = async (threadId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId: OWNER }, SECRET, Date.now());

    return proof;
};

const fetchFile = async (fileId: string, options: { threadId?: string; unlockProof?: string } = {}) =>
    await run(async (ctx) => await ctx.runQuery(getFileForUser, { fileId, userId: OWNER, ...options }));

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    lockedId = await lockedThread(2);
    otherLockedId = await lockedThread(2);
    openId = await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "Open", userId: OWNER }));

    secretFileId = await insertFile("salary.txt", "hash-secret");
    openFileId = await insertFile("notes.txt", "hash-open");

    await run(async (ctx) => {
        await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId: secretFileId, userId: OWNER });
        await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId: openFileId, userId: OWNER });
    });

    await messageWith(lockedId, secretFileId, 0);
    await messageWith(openId, openFileId, 0);
});

describe("getFileForUser and a locked chat's files", () => {
    it("refuses a file from a locked chat when it is attached with no thread id (the bypass)", async () => {
        await expect(fetchFile(secretFileId)).resolves.toBeNull();
    });

    it("refuses it in another, unlocked chat", async () => {
        await expect(fetchFile(secretFileId, { threadId: openId })).resolves.toBeNull();
    });

    it("refuses it in its own locked chat without that chat's proof", async () => {
        await expect(fetchFile(secretFileId, { threadId: lockedId })).resolves.toBeNull();
    });

    it("refuses it in a second locked chat, even with that chat's proof", async () => {
        await expect(fetchFile(secretFileId, { threadId: otherLockedId, unlockProof: await proofFor(otherLockedId) })).resolves.toBeNull();
    });

    it("serves it in its own locked chat with that chat's proof (positive)", async () => {
        const file = await fetchFile(secretFileId, { threadId: lockedId, unlockProof: await proofFor(lockedId) });

        expect(file).toMatchObject({ _id: secretFileId, filename: "salary.txt" });
    });

    it("serves a file that sits only in an unlocked chat, in a new chat (positive)", async () => {
        const file = await fetchFile(openFileId);

        expect(file).toMatchObject({ _id: openFileId, filename: "notes.txt" });
    });

    it("serves a file that sits only in an unlocked chat, in that chat (positive)", async () => {
        await expect(fetchFile(openFileId, { threadId: openId })).resolves.toMatchObject({ _id: openFileId });
    });

    it("finds a file attached behind more than one page of a locked chat's messages (the oldest message)", async () => {
        const deepLocked = await lockedThread(2);
        const deepFileId = await insertFile("deep.txt", "hash-deep");

        await run(async (ctx) => {
            await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId: deepFileId, userId: OWNER });
        });
        await messageWith(deepLocked, deepFileId, 0);
        await run(async (ctx) => {
            for (let order = 1; order <= 520; order += 1) {
                await ctx.db.insert("messages", {
                    message: { content: "plain", role: "user" },
                    order,
                    status: "success",
                    stepOrder: 0,
                    text: "plain",
                    threadId: deepLocked,
                    tool: false,
                    userId: OWNER,
                });
            }
        });

        await expect(fetchFile(deepFileId)).resolves.toBeNull();
    });
});
