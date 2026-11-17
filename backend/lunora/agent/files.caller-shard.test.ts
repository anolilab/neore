/**
 * The lock check for attached files runs on the CALLER's shard.
 *
 * `/chat/start` and `/chat/edit` run on the thread OWNER's shard. A collaborator's locked chat (its passcode rows and
 * file links) lives on the collaborator's shard, not the owner's, so a check made only on the owner's shard cannot see
 * it: a file from the collaborator's own locked chat would then attach to the owner's shared chat with no passcode.
 * The check that refuses it must run where those rows are: the caller's shard.
 *
 * The harness is one database for every shard, so the split itself is not reproduced here; these tests pin the
 * decision the caller's shard must make, and that it does not weaken the owner's own chats.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import type { Id } from "../_generated/dataModel";
import { mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { changeMessageFiles, gatedFileIdsOnCallerShard } from "./files";

const SECRET = "test-storage-signing-secret";
const OWNER = "owner-shard-owner";
const COLLAB = "owner-shard-collaborator";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;

let collabLockedId: string;
let collabOpenId: string;
let ownerSharedId: string;
let ownerLockedId: string;
let secretFileId: string;
let collabOpenFileId: string;
let ownerFileId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const insertFile = async (filename: string, hash: string, grantedTo: string) =>
    await run(async (ctx) => {
        const fileId = await ctx.db.insert("chatFiles", {
            extractionStatus: "pending",
            filename,
            hash,
            lastTouchedAt: 1,
            mediaType: "text/plain",
            refcount: 1,
            storageId: `storage-${hash}`,
        });

        await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId, userId: grantedTo });

        return fileId as string;
    });

const insertThread = async (userId: string, lockedAt?: number) =>
    await run(async (ctx) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "Chat", userId, ...(lockedAt !== undefined && { lockedAt }) });

        if (lockedAt !== undefined) {
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch,
                failedAttempts: 0,
                hash: "unused-by-proofs",
                iterations: 1000,
                salt: "unused-by-proofs",
                threadId,
                updatedAt: 1,
                userId,
            });
        }

        return threadId as string;
    });

/** Attaches a file through the message writer, which records the chat's link to it (as a real send does). */
const attach = async (threadId: string, owner: string, fileId: string) =>
    await run(async (ctx) => {
        await ctx.db.insert("messages", {
            fileIds: [fileId],
            message: { content: "attached", role: "user" },
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "attached",
            threadId,
            tool: false,
            userId: owner,
        });
        await changeMessageFiles(ctx, threadId as Id<"threads">, [], [fileId as Id<"chatFiles">]);
    });

const proofFor = async (threadId: string, userId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

    return proof;
};

/** What the caller's shard decides for a send that attaches `fileIds` into `threadId`. */
const gatedOnCallerShard = async (userId: string, fileIds: string[], options: { threadId?: string; unlockProof?: string } = {}): Promise<string[]> =>
    await run(
        async (ctx) =>
            await gatedFileIdsOnCallerShard(ctx, {
                fileIds: fileIds as Id<"chatFiles">[],
                userId,
                ...(options.threadId !== undefined && { threadId: options.threadId as Id<"threads"> }),
                ...(options.unlockProof !== undefined && { unlockProof: options.unlockProof }),
            }),
    );

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    // The collaborator's own locked chat, with a file attached there, and their own unlocked chat with another file.
    collabLockedId = await insertThread(COLLAB, 2);
    collabOpenId = await insertThread(COLLAB);
    secretFileId = await insertFile("salary.txt", "hash-collab-secret", COLLAB);
    collabOpenFileId = await insertFile("notes.txt", "hash-collab-open", COLLAB);
    await attach(collabLockedId, COLLAB, secretFileId);
    await attach(collabOpenId, COLLAB, collabOpenFileId);

    // The owner's shared chat (the one the collaborator attaches into), and the owner's own locked chat with a file.
    ownerSharedId = await insertThread(OWNER);
    ownerLockedId = await insertThread(OWNER, 2);
    ownerFileId = await insertFile("owner-secret.txt", "hash-owner-secret", OWNER);
    await attach(ownerLockedId, OWNER, ownerFileId);
});

describe("a collaborator's attach is checked on the collaborator's own shard", () => {
    it("refuses a file from the collaborator's own locked chat attached into the owner's shared chat", async () => {
        await expect(gatedOnCallerShard(COLLAB, [secretFileId], { threadId: ownerSharedId })).resolves.toEqual([secretFileId]);
    });

    it("refuses it in the collaborator's own unlocked chat too", async () => {
        await expect(gatedOnCallerShard(COLLAB, [secretFileId], { threadId: collabOpenId })).resolves.toEqual([secretFileId]);
    });

    it("refuses it with no thread named", async () => {
        await expect(gatedOnCallerShard(COLLAB, [secretFileId])).resolves.toEqual([secretFileId]);
    });

    it("serves the collaborator's unlocked file into the owner's shared chat (positive)", async () => {
        await expect(gatedOnCallerShard(COLLAB, [collabOpenFileId], { threadId: ownerSharedId })).resolves.toEqual([]);
    });

    it("serves the collaborator's locked file in its own locked chat with that chat's proof (positive)", async () => {
        const unlockProof = await proofFor(collabLockedId, COLLAB);

        await expect(gatedOnCallerShard(COLLAB, [secretFileId], { threadId: collabLockedId, unlockProof })).resolves.toEqual([]);
    });
});

describe("the owner's own chats keep the same check", () => {
    it("refuses the owner's locked file attached into the owner's unlocked shared chat", async () => {
        await expect(gatedOnCallerShard(OWNER, [ownerFileId], { threadId: ownerSharedId })).resolves.toEqual([ownerFileId]);
    });

    it("serves the owner's locked file in its own locked chat only with that chat's proof", async () => {
        await expect(gatedOnCallerShard(OWNER, [ownerFileId], { threadId: ownerLockedId })).resolves.toEqual([ownerFileId]);

        const unlockProof = await proofFor(ownerLockedId, OWNER);

        await expect(gatedOnCallerShard(OWNER, [ownerFileId], { threadId: ownerLockedId, unlockProof })).resolves.toEqual([]);
    });
});
