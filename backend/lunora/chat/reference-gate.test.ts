/**
 * The reference images of `/chat/media` are checked on the caller's shard (`chat/reference-gate.ts`): a reference is the caller's
 * own row, under that row's own URL, in a chat the caller may read with the proof the request carries for that chat.
 */
import { REFERENCE_MEDIA_CAPS } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { gateReferencesOnCallerShard } from "./reference-gate";

const SECRET = "test-storage-signing-secret";
const OWNER = "reference-owner";
const COLLAB = "reference-collaborator";
const OPEN_URL = "https://files.example.test/open.png";
const LOCKED_URL = "https://files.example.test/locked.png";
const COLLAB_LOCKED_URL = "https://files.example.test/collab-locked.png";
const DOC_URL = "data:image/png;base64,AAAA";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;

let ownerOpenId: string;
let ownerLockedId: string;
let collabLockedId: string;
let openFileId: string;
let lockedFileId: string;
let collabLockedFileId: string;
let openDocId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const insertThread = async (userId: string, locked: boolean) =>
    await run(async (ctx) => {
        const threadId = await ctx.db.insert("threads", { status: "active", title: "Chat", userId, ...(locked && { lockedAt: 2 }) });

        if (locked) {
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

const insertFile = async (userId: string, chatId: string, url: string) =>
    await run(async (ctx) => (await ctx.db.insert("files", { chatId, name: "image.png", size: 1, type: "image/png", url, userId })) as string);

const insertDocument = async (userId: string, threadId: string, content: string) =>
    await run(async (ctx) => (await ctx.db.insert("documents", { content, kind: "image", threadId, title: "Image", userId, version: 1 })) as string);

const proofFor = async (threadId: string, userId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

    return proof;
};

/** The gate's answer for one reference: the picker's id and URL, asked for in `targetThreadId` with `unlockProof`. */
const refusedFor = async (userId: string, references: { id: string; url: string }[], targetThreadId: string, unlockProof?: string): Promise<boolean> => {
    const { refused } = await run(
        async (ctx) =>
            await ctx.runQuery(gateReferencesOnCallerShard as never, {
                referenceIds: references.map((reference) => reference.id),
                referenceImages: references.map((reference) => reference.url),
                targetThreadId,
                ...(unlockProof !== undefined && { unlockProof }),
                userId,
            }),
    );

    return refused as boolean;
};

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    ownerOpenId = await insertThread(OWNER, false);
    ownerLockedId = await insertThread(OWNER, true);
    collabLockedId = await insertThread(COLLAB, true);

    openFileId = await insertFile(OWNER, ownerOpenId, OPEN_URL);
    lockedFileId = await insertFile(OWNER, ownerLockedId, LOCKED_URL);
    collabLockedFileId = await insertFile(COLLAB, collabLockedId, COLLAB_LOCKED_URL);
    openDocId = await insertDocument(OWNER, ownerOpenId, DOC_URL);
});

describe("a media request's references are checked on the caller's shard", () => {
    it("serves the caller's own file in an unlocked chat", async () => {
        await expect(refusedFor(OWNER, [{ id: `file:${openFileId}`, url: OPEN_URL }], ownerOpenId)).resolves.toBe(false);
    });

    it("serves the caller's own document in an unlocked chat", async () => {
        await expect(refusedFor(OWNER, [{ id: `doc:${openDocId}`, url: DOC_URL }], ownerOpenId)).resolves.toBe(false);
    });

    it("refuses a reference whose URL is not its id's own URL", async () => {
        await expect(refusedFor(OWNER, [{ id: `file:${openFileId}`, url: LOCKED_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses another user's file, even under its own URL", async () => {
        await expect(refusedFor(COLLAB, [{ id: `file:${openFileId}`, url: OPEN_URL }], ownerOpenId)).resolves.toBe(true);
    });

    it("refuses the caller's own file from a locked chat when no proof is given", async () => {
        await expect(refusedFor(OWNER, [{ id: `file:${lockedFileId}`, url: LOCKED_URL }], ownerLockedId)).resolves.toBe(true);
    });

    it("serves a locked chat's file when the request carries that chat's proof and names that chat as its target", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(OWNER, [{ id: `file:${lockedFileId}`, url: LOCKED_URL }], ownerLockedId, proof)).resolves.toBe(false);
    });

    it("refuses a locked chat's file when the proof is for another chat than the target", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(OWNER, [{ id: `file:${lockedFileId}`, url: LOCKED_URL }], ownerOpenId, proof)).resolves.toBe(true);
    });

    it("refuses a collaborator's file from their own locked chat, even with the target's proof", async () => {
        const proof = await proofFor(ownerLockedId, OWNER);

        await expect(refusedFor(COLLAB, [{ id: `file:${collabLockedFileId}`, url: COLLAB_LOCKED_URL }], ownerLockedId, proof)).resolves.toBe(true);
    });

    it("refuses when any one reference is refused", async () => {
        await expect(
            refusedFor(
                OWNER,
                [
                    { id: `file:${openFileId}`, url: OPEN_URL },
                    { id: `file:${lockedFileId}`, url: LOCKED_URL },
                ],
                ownerOpenId,
            ),
        ).resolves.toBe(true);
    });

    it("refuses a list longer than the media cap, before any row is read", async () => {
        const repeated = Array.from({ length: REFERENCE_MEDIA_CAPS.images + 1 }, () => {
            return { id: `file:${openFileId}`, url: OPEN_URL };
        });

        await expect(refusedFor(OWNER, repeated, ownerOpenId)).resolves.toBe(true);
    });

    it("refuses a malformed id", async () => {
        await expect(refusedFor(OWNER, [{ id: "not-an-id", url: OPEN_URL }], ownerOpenId)).resolves.toBe(true);
    });
});
