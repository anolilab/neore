/**
 * Knowledge attached to a LOCKED chat is that chat's content, so the search
 * scope for it needs the chat's proof, or an admitted run. Without either, the
 * scope is explicitly empty (never the whole knowledge base). With either, the
 * chat's own attachments are searched, the way an unlocked chat's are.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import { hashPasscode, mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { gatedKnowledgeFileIds, resolveRetrievalScope } from "./collections";

const SECRET = "test-storage-signing-secret";
const OWNER = "owner-knowledge";
const PASSCODE = "passcode-knowledge";

let harness: ReturnType<typeof lunoraTest>;
let lockedId: string;
let openId: string;
let fileId: string;
let epoch: string;

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const scopeOf = async (threadId: string, options: { admittedRun?: boolean; unlockProof?: string } = {}) =>
    (await run(async (ctx) => await ctx.runQuery(resolveRetrievalScope, { threadId, userId: OWNER, ...options }))) as {
        fileIds: string[];
        hasExplicitScope: boolean;
    };

const proofFor = async (proofEpoch: string = epoch) => {
    const { proof } = await mintUnlockProof({ epoch: proofEpoch, threadId: lockedId, userId: OWNER }, SECRET, Date.now());

    return proof;
};

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    const hashed = await hashPasscode(PASSCODE, 1000);

    lockedId = await run(
        async (ctx) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 2, status: "active", title: "Locked", updatedAt: 3, userId: OWNER }),
    );
    openId = await run(async (ctx) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "Open", updatedAt: 3, userId: OWNER }));

    await run(async (ctx) => {
        await ctx.db.insert("threadPasscodes", {
            createdAt: 1,
            epoch,
            failedAttempts: 0,
            hash: hashed.hash,
            iterations: hashed.iterations,
            salt: hashed.salt,
            threadId: lockedId,
            updatedAt: 1,
            userId: OWNER,
        });
    });

    fileId = await run(
        async (ctx) =>
            await ctx.db.insert("knowledgeFiles", {
                createdAt: 1,
                mimeType: "text/plain",
                name: "salary.txt",
                size: 10,
                status: "indexed",
                userId: OWNER,
            }),
    );

    await run(async (ctx) => {
        await ctx.db.insert("threadKnowledge", { addedAt: 1, knowledgeFileId: fileId, threadId: lockedId });
        await ctx.db.insert("threadKnowledge", { addedAt: 1, knowledgeFileId: fileId, threadId: openId });
    });
});

describe("resolveRetrievalScope for a locked chat", () => {
    it("gives the owner an explicit empty scope without a proof or an admitted run (negative)", async () => {
        await expect(scopeOf(lockedId)).resolves.toEqual({ fileIds: [], foreign: [], hasExplicitScope: true });
    });

    it("searches the chat's own attachments with a valid proof (positive)", async () => {
        const scope = await scopeOf(lockedId, { unlockProof: await proofFor() });

        expect(scope.fileIds).toEqual([fileId]);
        expect(scope.hasExplicitScope).toBe(true);
    });

    it("searches them for a run admitted under the lock (positive)", async () => {
        const scope = await scopeOf(lockedId, { admittedRun: true });

        expect(scope.fileIds).toEqual([fileId]);
    });

    it("refuses a proof from an older epoch, so a re-lock also closes the search (negative)", async () => {
        const scope = await scopeOf(lockedId, { unlockProof: await proofFor(newPasscodeEpoch()) });

        expect(scope).toEqual({ fileIds: [], foreign: [], hasExplicitScope: true });
    });

    it("answers an admitted locked chat with no attachments as no explicit scope, so the general index applies", async () => {
        const bare = await run(async (ctx) => await ctx.db.insert("threads", { createdAt: 1, lockedAt: 2, status: "active", userId: OWNER }));
        const scope = await run(async (ctx) => await ctx.runQuery(resolveRetrievalScope, { admittedRun: true, threadId: bare, userId: OWNER }));

        expect(scope).toEqual({ fileIds: [], foreign: [], hasExplicitScope: false });
    });

    it("leaves an unlocked chat's attachments in scope with no proof (baseline)", async () => {
        const scope = await scopeOf(openId);

        expect(scope.fileIds).toEqual([fileId]);
    });
});

describe("gatedKnowledgeFileIds: knowledge on a locked chat is gated for id and index searches", () => {
    const gated = async (options: { admittedRun?: boolean; threadId?: string; unlockProof?: string } = {}) =>
        (await run(async (ctx) => await ctx.runQuery(gatedKnowledgeFileIds, { userId: OWNER, ...options }))) as string[];

    it("gates a file attached to the locked chat when nothing opens it (negative)", async () => {
        await expect(gated()).resolves.toContain(fileId);
    });

    it("leaves a file attached only to the unlocked chat alone (positive)", async () => {
        const openOnly = await run(
            async (ctx) =>
                await ctx.db.insert("knowledgeFiles", { createdAt: 1, mimeType: "text/plain", name: "open.txt", size: 1, status: "indexed", userId: OWNER }),
        );

        await run(async (ctx) => {
            await ctx.db.insert("threadKnowledge", { addedAt: 1, knowledgeFileId: openOnly, threadId: openId });
        });

        expect(await gated()).not.toContain(openOnly);
    });

    it("opens the named locked chat with its valid proof (positive)", async () => {
        expect(await gated({ threadId: lockedId, unlockProof: await proofFor() })).not.toContain(fileId);
    });

    it("opens the named locked chat for an admitted run (positive)", async () => {
        expect(await gated({ admittedRun: true, threadId: lockedId })).not.toContain(fileId);
    });

    it("keeps it gated for a proof from an older epoch (negative)", async () => {
        expect(await gated({ threadId: lockedId, unlockProof: await proofFor(newPasscodeEpoch()) })).toContain(fileId);
    });

    it("gates a file reached through a collection the locked chat holds (negative)", async () => {
        const collectionId = await run(
            async (ctx) => await ctx.db.insert("knowledgeCollections", { createdAt: 1, name: "Salary", updatedAt: 1, userId: OWNER }),
        );
        const collectionFileId = await run(
            async (ctx) =>
                await ctx.db.insert("knowledgeFiles", {
                    collectionId,
                    createdAt: 1,
                    mimeType: "text/plain",
                    name: "pay.txt",
                    size: 1,
                    status: "indexed",
                    userId: OWNER,
                }),
        );

        await run(async (ctx) => {
            await ctx.db.insert("knowledgeCollectionLinks", { addedAt: 1, collectionId, threadId: lockedId, userId: OWNER });
        });

        expect(await gated()).toContain(collectionFileId);
    });
});
