/**
 * The chat-file readers (`getChatFileExtraction`, `getChatFileImageUrl`) answer
 * a grant holder. A file on one of the caller's LOCKED chats is that chat's
 * content, so these readers refuse it unless the request names that chat and
 * carries its valid proof. Each refusal has a positive twin.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mintUnlockProof, newPasscodeEpoch } from "./lib/thread-lock";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { changeMessageFiles } from "./agent/files";
import { getChatFileExtraction, getChatFileImageUrl } from "./file";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("./lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

const SECRET = "test-storage-signing-secret";
const STORAGE_UNAVAILABLE = /ctx\.storage is not available/;
const OWNER = "owner-readers";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;
let lockedId: string;
let otherLockedId: string;
let openId: string;
let secretFileId: string;
let openFileId: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);
const as = (userId: string) => harness.withIdentity({ userId } as never);

const insertFile = async (hash: string) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("chatFiles", {
                extractionStatus: "pending",
                filename: `${hash}.txt`,
                hash,
                lastTouchedAt: 1,
                mediaType: "text/plain",
                refcount: 1,
                storageId: `storage-${hash}`,
            }),
    );

const lockedThread = async () =>
    await run(async (ctx) => {
        const threadId = await ctx.db.insert("threads", { createdAt: 1, lockedAt: 2, status: "active", title: "Locked", updatedAt: 3, userId: OWNER });

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

/** Attaches through the message writer, which records the chat's link to the file. */
const attach = async (threadId: string, fileId: string) =>
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
            userId: OWNER,
        });
        await changeMessageFiles(ctx, threadId as Id<"threads">, [], [fileId as Id<"chatFiles">]);
    });

const proofFor = async (threadId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId: OWNER }, SECRET, Date.now());

    return proof;
};

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    lockedId = await lockedThread();
    otherLockedId = await lockedThread();
    openId = await run(async (ctx) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "Open", updatedAt: 3, userId: OWNER }));

    secretFileId = await insertFile("hash-secret");
    openFileId = await insertFile("hash-open");

    await run(async (ctx) => {
        await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId: secretFileId, userId: OWNER });
        await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId: openFileId, userId: OWNER });
    });

    await attach(lockedId, secretFileId);
    await attach(openId, openFileId);
});

describe("getChatFileExtraction and a locked chat's file", () => {
    it("refuses a file on a locked chat with no thread id (negative)", async () => {
        await expect(as(OWNER).query(getChatFileExtraction as never, { fileId: secretFileId } as never)).resolves.toBeNull();
    });

    it("refuses it when the named chat's proof is missing (negative)", async () => {
        await expect(as(OWNER).query(getChatFileExtraction as never, { fileId: secretFileId, threadId: lockedId } as never)).resolves.toBeNull();
    });

    it("refuses it when the proof is for another locked chat (negative)", async () => {
        const args = { fileId: secretFileId, threadId: lockedId, unlockProof: await proofFor(otherLockedId) };

        await expect(as(OWNER).query(getChatFileExtraction as never, args as never)).resolves.toBeNull();
    });

    it("serves it to the viewer of its own locked chat with that chat's proof (positive)", async () => {
        const args = { fileId: secretFileId, threadId: lockedId, unlockProof: await proofFor(lockedId) };

        await expect(as(OWNER).query(getChatFileExtraction as never, args as never)).resolves.toEqual({ status: "pending" });
    });

    it("serves a file that is only in an unlocked chat, with no proof (positive)", async () => {
        await expect(as(OWNER).query(getChatFileExtraction as never, { fileId: openFileId } as never)).resolves.toEqual({ status: "pending" });
    });
});

describe("getChatFileImageUrl and a locked chat's file", () => {
    it("refuses a file on a locked chat with no thread id, so no signed URL is issued (negative)", async () => {
        await expect(as(OWNER).query(getChatFileImageUrl as never, { fileId: secretFileId } as never)).resolves.toBeNull();
    });

    it("refuses it when the proof is for another locked chat (negative)", async () => {
        const args = { fileId: secretFileId, threadId: lockedId, unlockProof: await proofFor(otherLockedId) };

        await expect(as(OWNER).query(getChatFileImageUrl as never, args as never)).resolves.toBeNull();
    });

    it("lets the viewer with that chat's proof through to signing (positive)", async () => {
        // The in-memory harness has no `ctx.storage`, so the signing call itself cannot answer. Reaching it at all
        // means the gate admitted the request; the refusals above return null before it.
        const args = { fileId: secretFileId, threadId: lockedId, unlockProof: await proofFor(lockedId) };

        await expect(as(OWNER).query(getChatFileImageUrl as never, args as never)).rejects.toThrow(STORAGE_UNAVAILABLE);
    });
});
