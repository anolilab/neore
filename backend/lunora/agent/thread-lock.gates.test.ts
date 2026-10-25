/**
 * The locked-thread gates on the content readers: each path refuses or skips a
 * locked thread without a valid proof, and admits the owner with one. Lists
 * return the stub. Search never returns a locked row across threads.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    getThreadUsage,
    getThreadWithAccess,
    getThread,
    getThreadByPublicToken,
    getThreadListDataBatchHandler,
    searchThreadsByTitleAndSummary,
    searchThreadTitles,
    updateThreadVisibility,
    listThreadsByUserIdInternal,
} from "./threads";
import {
    _fetchSearchMessages,
    cloneMessageBatch,
    getMessageSearchFields,
    getMessagesByIds,
    listMessagesByThreadId,
    listMessagesByThreadIdHandler,
    textSearch,
} from "./messages";
import { list as listStreams } from "./streams";
import { getDocument, getDocumentsByThread, updateDocument } from "./documents";
import { listActivePathPage } from "./branches";
import { createThreadAccess } from "./sharing";
import { detachFromThread, getThreadKnowledge } from "../knowledge/functions";
import { detachCollectionFromThread, getThreadCollections, resolveRetrievalScope } from "../knowledge/collections";
import { deleteThreadVariable, getThreadVariables, setThreadVariables, updateThreadVariable } from "../prompts/functions";
import { moveThreadToProject } from "../projects/functions";
import { getMessageMemoryUsage, recordRetrievedMemories } from "../memory/functions";
import { hashPasscode, mintUnlockProof, newPasscodeEpoch, THREAD_LOCKED_CODE } from "../lib/thread-lock";
import schema from "../schema";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const SECRET = "p".repeat(40);
const OWNER = "owner-user";
const STRANGER = "stranger-user"; // secret-scanner:allow a test user id
const PASSCODE = "passcode-1";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;
let lockedId: string;
let openId: string;
let epoch: string;

const as = (userId: string) => harness.withIdentity({ userId } as never);

const proofFor = async (userId: string = OWNER, threadId: string = lockedId) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId }, SECRET, Date.now());

    return proof;
};

const run = <T>(body: (ctx: any) => Promise<T>): Promise<T> => harness.run(body as never);

const firstMessageId = async (ctx: any, threadId: string) => {
    const row = await ctx.db
        .query("messages")
        .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
        .first();

    return row._id;
};

const firstDocumentId = async (ctx: any, threadId: string) => {
    const row = await ctx.db
        .query("documents")
        .withIndex("by_threadId_and_kind", (q: any) => q.eq("threadId", threadId))
        .first();

    return row._id;
};

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();

    const hashed = await hashPasscode(PASSCODE, 1000);

    lockedId = await run(
        async (ctx) =>
            await ctx.db.insert("threads", {
                createdAt: 1,
                lockedAt: 2,
                status: "active",
                summary: "salary figures",
                title: "Salary plan",
                updatedAt: 3,
                userId: OWNER,
            }),
    );
    openId = await run(
        async (ctx) =>
            await ctx.db.insert("threads", {
                createdAt: 1,
                status: "active",
                summary: "groceries",
                title: "Salary plan open",
                updatedAt: 3,
                userId: OWNER,
            }),
    );

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
        await ctx.db.insert("messages", {
            order: 0,
            status: "success",
            stepOrder: 0,
            text: "salary figures for the year",
            threadId: lockedId,
            tool: false,
            userId: OWNER,
        });
        await ctx.db.insert("messages", {
            order: 1,
            status: "success",
            stepOrder: 0,
            text: "salary open note",
            threadId: openId,
            tool: false,
            userId: OWNER,
        });
        await ctx.db.insert("documents", {
            content: "secret salary doc",
            kind: "text",
            threadId: lockedId,
            title: "Salary doc",
            userId: OWNER,
            version: 1,
        });
        await ctx.db.insert("streamingMessages", {
            order: 0,
            state: { kind: "streaming", lastHeartbeat: 1 },
            stateKind: "streaming",
            stepOrder: 0,
            threadId: lockedId,
            userId: OWNER,
        });
        await ctx.db.insert("threadVariables", {
            threadId: lockedId,
            updatedAt: 1,
            userId: OWNER,
            variables: [{ name: "x", value: "secret" }],
        });
    });
});

describe("thread row reads", () => {
    it("getThread hands the owner of a locked chat the stub, the full row only with a proof", async () => {
        const stub: any = await as(OWNER).query(getThread as never, { threadId: lockedId } as never);

        expect(stub.title).toBeUndefined();
        expect(stub.lockedAt).toBeDefined();

        const opened: any = await as(OWNER).query(getThread as never, { threadId: lockedId, unlockProof: await proofFor() } as never);

        expect(opened.title).toBe("Salary plan");
        expect(await as(STRANGER).query(getThread as never, { threadId: lockedId } as never)).toBeNull();
    });

    it("getThreadWithAccess (internal) gives nothing for a locked thread without its proof", async () => {
        expect(await run(async (ctx) => await ctx.runQuery(getThreadWithAccess, { threadId: lockedId, userId: OWNER }))).toBeNull();
        const row: any = await run(
            async (ctx) => await ctx.runQuery(getThreadWithAccess, { threadId: lockedId, unlockProof: await proofFor(), userId: OWNER }),
        );

        expect(row?.title).toBe("Salary plan");
    });

    it("getThreadByPublicToken refuses a locked thread even if it is still marked public", async () => {
        await run(async (ctx) => await ctx.db.patch(lockedId as never, { isPublic: true, publicAccessToken: "tok-locked" }));

        expect(await run(async (ctx) => await ctx.runQuery(getThreadByPublicToken, { publicAccessToken: "tok-locked" }))).toBeNull();
    });

    it("getThreadUsage refuses the owner without a proof", async () => {
        await expect(as(OWNER).query(getThreadUsage as never, { threadId: lockedId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
        const usage: any = await as(OWNER).query(getThreadUsage as never, { threadId: lockedId, unlockProof: await proofFor() } as never);

        expect(usage).toMatchObject({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    });

    it("the GDPR thread list and the list view carry the stub, never the title", async () => {
        const listed: any = await run(async (ctx) => await ctx.runQuery(listThreadsByUserIdInternal, { userId: OWNER }));
        const internal: any[] = listed.page;
        const locked = internal.find((thread) => thread._id === lockedId);
        const open = internal.find((thread) => thread._id === openId);

        expect(locked.title).toBeUndefined();
        expect(locked.lockedAt).toBeDefined();
        expect(open.title).toBe("Salary plan open");

        const batch: any = await run(async (ctx) => await getThreadListDataBatchHandler(ctx, { userId: OWNER }));
        const inBatch = batch.threads.page.find((thread: any) => thread._id === lockedId);

        expect(inBatch.title).toBeUndefined();
        expect(inBatch.lockedAt).toBeDefined();
    });
});

describe("search", () => {
    it("searchThreadTitles never returns a locked chat's title", async () => {
        const hits: any[] = await as(OWNER).query(searchThreadTitles as never, { limit: 10, query: "Salary", userId: OWNER } as never);

        expect(hits.map((hit) => hit._id)).toEqual([openId]);
    });

    it("searchThreadsByTitleAndSummary excludes a locked chat by its summary too", async () => {
        const hits: any[] = await as(OWNER).query(searchThreadsByTitleAndSummary as never, { limit: 10, query: "figures", userId: OWNER } as never);

        expect(hits.map((hit) => hit._id)).not.toContain(lockedId);
    });
});

describe("message reads", () => {
    it("listMessagesByThreadId refuses the owner without a proof and admits her with one", async () => {
        await expect(as(OWNER).query(listMessagesByThreadId as never, { order: "asc", threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });

        const opened: any = await as(OWNER).query(
            listMessagesByThreadId as never,
            { order: "asc", threadId: lockedId, unlockProof: await proofFor() } as never,
        );

        expect(opened.page).toHaveLength(1);
    });

    it("a stranger gets an empty page for a locked chat, with or without a proof", async () => {
        const page: any = await as(STRANGER).query(listMessagesByThreadId as never, { order: "asc", threadId: lockedId } as never);

        expect(page.page).toEqual([]);
    });

    it("listMessagesByThreadIdHandler (every system reader) skips a locked chat without its proof", async () => {
        const skipped = await run(async (ctx) => await listMessagesByThreadIdHandler(ctx, { order: "asc", threadId: lockedId as never }));
        const read = await run(
            async (ctx) => await listMessagesByThreadIdHandler(ctx, { order: "asc", threadId: lockedId as never, unlockProof: await proofFor() }),
        );

        expect(skipped.page).toEqual([]);
        expect(read.page).toHaveLength(1);
    });

    it("getMessagesByIds returns null for a locked message without its proof", async () => {
        const messageId = await run(async (ctx) => await firstMessageId(ctx, lockedId));

        const skipped: any[] = await run(async (ctx) => await ctx.runQuery(getMessagesByIds, { messageIds: [messageId] }));
        const read: any[] = await run(
            async (ctx) => await ctx.runQuery(getMessagesByIds, { messageIds: [messageId], threadId: lockedId, unlockProof: await proofFor() }),
        );

        expect(skipped).toEqual([null]);
        expect(read[0]?.text).toBe("salary figures for the year");
    });

    it("getMessageSearchFields hands back no text for a locked message without its proof", async () => {
        const messageId = await run(async (ctx) => await firstMessageId(ctx, lockedId));

        const skipped: any = await run(async (ctx) => await ctx.runQuery(getMessageSearchFields, { messageId }));

        expect(skipped.text).toBeUndefined();
    });

    it("textSearch never returns a locked chat's message to a user-wide search, even with its proof", async () => {
        const { messages: hits }: { messages: { threadId: string }[] } = await run(
            async (ctx) => await ctx.runQuery(textSearch, { limit: 10, searchAllMessagesForUserId: OWNER, text: "salary", unlockProof: await proofFor() }),
        );

        expect(hits.map((hit) => hit.threadId)).not.toContain(lockedId);
    });

    it("textSearch scoped to a locked thread is empty without the proof and returns its rows with it", async () => {
        const { messages: skipped }: { messages: { threadId: string }[] } = await run(
            async (ctx) => await ctx.runQuery(textSearch, { limit: 10, text: "salary", threadId: lockedId }),
        );
        const { messages: read }: { messages: { threadId: string }[] } = await run(
            async (ctx) => await ctx.runQuery(textSearch, { limit: 10, text: "salary", threadId: lockedId, unlockProof: await proofFor() }),
        );

        expect(skipped).toEqual([]);
        expect(read.map((hit) => hit.threadId)).toEqual([lockedId]);
    });

    it("streams are not read for a locked chat without its proof", async () => {
        expect(await as(OWNER).query(listStreams as never, { statuses: ["streaming"], threadId: lockedId } as never)).toEqual([]);
        const streams: any[] = await as(OWNER).query(
            listStreams as never,
            { statuses: ["streaming"], threadId: lockedId, unlockProof: await proofFor() } as never,
        );

        expect(streams).toHaveLength(1);
    });
});

describe("documents", () => {
    it("getDocumentsByThread refuses the owner without a proof", async () => {
        await expect(as(OWNER).query(getDocumentsByThread as never, { threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("getDocument refuses the owner without a proof and returns the document with one", async () => {
        const documentId = await run(async (ctx) => await firstDocumentId(ctx, lockedId));

        await expect(as(OWNER).query(getDocument as never, { documentId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
        const doc: any = await as(OWNER).query(getDocument as never, { documentId, unlockProof: await proofFor() } as never);

        expect(doc.title).toBe("Salary doc");
    });
});

describe("sharing and forks", () => {
    it("updateThreadVisibility refuses to make a locked chat public (BAD_REQUEST)", async () => {
        await expect(run(async (ctx) => await ctx.runMutation(updateThreadVisibility, { isPublic: true, threadId: lockedId }))).rejects.toMatchObject({
            code: "BAD_REQUEST",
        });
    });

    it("createThreadAccess refuses a grant on a locked chat (BAD_REQUEST)", async () => {
        await expect(
            run(
                async (ctx) =>
                    await ctx.runMutation(createThreadAccess, {
                        grantedBy: OWNER,
                        ownerId: OWNER,
                        permission: "read",
                        threadId: lockedId,
                        userId: STRANGER,
                    }),
            ),
        ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("cloneMessageBatch refuses a locked source without its proof and copies it with one", async () => {
        const targetId = await run(
            async (ctx) => await ctx.db.insert("threads", { createdAt: 1, status: "active", title: "Fork", updatedAt: 1, userId: OWNER }),
        );
        const args = { paginationOpts: { cursor: null, numItems: 10 }, sourceThreadId: lockedId, targetThreadId: targetId };

        await expect(run(async (ctx) => await ctx.runMutation(cloneMessageBatch, args as never))).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });

        const copied: any = await run(async (ctx) => await ctx.runMutation(cloneMessageBatch, { ...args, unlockProof: await proofFor() } as never));

        expect(copied.numCopied).toBe(1);
    });
});

describe("knowledge, prompts, projects and memory", () => {
    it("getThreadKnowledge refuses the owner without a proof", async () => {
        await expect(as(OWNER).query(getThreadKnowledge as never, { threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("resolveRetrievalScope gives a locked chat an empty explicit scope (no fallback to the whole base)", async () => {
        const scope: any = await run(async (ctx) => await ctx.runQuery(resolveRetrievalScope, { threadId: lockedId, userId: OWNER }));

        expect(scope).toEqual({ fileIds: [], foreign: [], hasExplicitScope: true });
    });

    it("getThreadVariables and setThreadVariables refuse the owner's locked variables without a proof", async () => {
        await expect(as(OWNER).query(getThreadVariables as never, { threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
        await expect(
            as(OWNER).mutation(setThreadVariables as never, { threadId: lockedId, variables: [{ name: "x", value: "y" }] } as never),
        ).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("moveThreadToProject refuses a locked thread without a proof", async () => {
        await expect(as(OWNER).mutation(moveThreadToProject as never, { threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("getMessageMemoryUsage refuses the owner without a proof", async () => {
        const messageId = await run(async (ctx) => await firstMessageId(ctx, lockedId));

        await expect(as(OWNER).query(getMessageMemoryUsage as never, { messageId } as never)).rejects.toMatchObject({ data: { code: THREAD_LOCKED_CODE } });
    });

    it("recordRetrievedMemories writes nothing onto a locked chat's message", async () => {
        const messageId = await run(async (ctx) => await firstMessageId(ctx, lockedId));

        await run(async (ctx) => await ctx.runMutation(recordRetrievedMemories, { memories: [{ memoryId: "m1", score: 1 }], messageId, userId: OWNER }));
        const message: any = await run(async (ctx) => await ctx.db.get(messageId));

        expect(message.retrievedMemories).toBeUndefined();
    });
});

describe("the remaining writers and readers of a locked chat", () => {
    const documentIdOf = () => run(async (ctx) => await firstDocumentId(ctx, lockedId));

    it("updateDocument refuses an edit to a locked chat's document without its proof", async () => {
        const documentId = await documentIdOf();

        await expect(as(OWNER).mutation(updateDocument as never, { content: "changed", documentId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("updateThreadVariable and deleteThreadVariable refuse the owner's locked variables without a proof", async () => {
        await expect(as(OWNER).mutation(updateThreadVariable as never, { name: "x", threadId: lockedId, value: "y" } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
        await expect(as(OWNER).mutation(deleteThreadVariable as never, { name: "x", threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("getThreadCollections, detachFromThread and detachCollectionFromThread refuse the owner without a proof", async () => {
        await expect(as(OWNER).query(getThreadCollections as never, { threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
        await expect(as(OWNER).mutation(detachFromThread as never, { knowledgeFileId: "k", threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
        await expect(as(OWNER).mutation(detachCollectionFromThread as never, { collectionId: "c", threadId: lockedId } as never)).rejects.toMatchObject({
            data: { code: THREAD_LOCKED_CODE },
        });
    });

    it("listActivePathPage reads a locked chat's branch path only with its proof", async () => {
        const leaf = await run(async (ctx) => await firstMessageId(ctx, lockedId));
        const thread = { _id: lockedId as never, activeLeafMessageId: leaf };

        expect(await run(async (ctx) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 5 }))).toBeNull();
        const page = await run(async (ctx) => await listActivePathPage(ctx, thread, { cursor: null, numItems: 5 }, await proofFor()));

        expect(page?.page).toHaveLength(1);
    });

    it("_fetchSearchMessages (vector hits) drops a locked chat's hit from a user-wide search and keeps an open one", async () => {
        await run(async (ctx) => {
            const locked = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", lockedId))
                .first();
            const open = await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", openId))
                .first();

            await ctx.db.patch(locked._id, { embeddingId: "emb-locked" });
            await ctx.db.patch(open._id, { embeddingId: "emb-open" });
        });

        const hits: any[] = await run(
            async (ctx) =>
                await ctx.runQuery(_fetchSearchMessages, {
                    embeddingIds: ["emb-locked", "emb-open"],
                    limit: 5,
                    messageRange: { after: 0, before: 0 },
                    searchAllMessagesForUserId: OWNER,
                    unlockProof: await proofFor(),
                } as never),
        );

        // The open hit proves the query found rows; the locked one is dropped even with its proof.
        expect(hits.map((hit) => hit.threadId)).toEqual([openId]);
    });
});
