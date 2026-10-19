/**
 * A locked chat's attachments before the file links existed. Until the chat is
 * indexed (`filesIndexedAt`) the gate reads its messages, so the file stays
 * gated; once the walk stamps the row the gate reads the links. Reads go through
 * the RLS-guarded chat-file reader, as a viewer's request does.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BACKFILL_PAGE, backfillChatFileLinks, backfillUnindexedFileLinks } from "./file-link-backfill";
import { getChatFileExtraction } from "../file";
import { mintUnlockProof, newPasscodeEpoch } from "../lib/thread-lock";
import schema from "../schema";
import { enableThreadLock, inheritPasscodeHandler, lockThread } from "./thread-lock";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const SECRET = "test-storage-signing-secret";
const OWNER = "owner-backfill";
const PASSCODE = "passcode-1";

let harness: ReturnType<typeof lunoraTest>;
let epoch: string;

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

const grant = async (fileId: string) => await run(async (ctx) => await ctx.db.insert("chatFileAccess", { createdAt: 1, fileId, userId: OWNER }));

/** A message written with no link: the chat as it was before the links existed. */
const legacyMessage = async (threadId: string, order: number, fileIds: string[] = []) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("messages", {
                ...(fileIds.length > 0 && { fileIds }),
                message: { content: "attached", role: "user" },
                order,
                status: "success",
                stepOrder: 0,
                text: "attached",
                threadId,
                tool: false,
                userId: OWNER,
            }),
    );

const newThread = async (lockedAt?: number) =>
    await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "Chat", userId: OWNER, ...(lockedAt !== undefined && { lockedAt }) }));

const passcodeRow = async (threadId: string, filesIndexedAt?: number) =>
    await run(
        async (ctx) =>
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
                ...(filesIndexedAt !== undefined && { filesIndexedAt }),
            }),
    );

const rowOf = async (threadId: string) =>
    await run(
        async (ctx) =>
            await ctx.db
                .query("threadPasscodes")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first(),
    );

const stampOf = async (threadId: string) => {
    const row = await rowOf(threadId);

    return row?.filesIndexedAt;
};

const linksOf = async (threadId: string) =>
    await run(
        async (ctx) =>
            await ctx.db
                .query("chatFileThreads")
                .withIndex("by_threadId", (q: any) => q.eq("threadId", threadId))
                .collect(),
    );

const dropMessages = async (threadId: string) =>
    await run(async (ctx) => {
        const rows = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
            .collect();

        for (const row of rows) {
            await ctx.db.delete(row._id);
        }
    });

const jobsFor = (name: string) => harness.scheduler.list().filter((job) => job.functionPath?.includes(name) === true);

/**
 * Runs the walk's queued steps by their args, as the scheduler would, until
 * none is left. Returns how many ran.
 */
const drainBackfill = async () => {
    const done = new Set<string>();

    for (;;) {
        const pending = jobsFor("backfillChatFileLinks").filter((job) => !done.has(job.id));

        if (pending.length === 0) {
            return done.size;
        }

        for (const job of pending) {
            done.add(job.id);
            await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, job.args as never));
        }
    }
};

const readExtraction = async (fileId: string, threadId?: string, unlockProof?: string) =>
    await as(OWNER).query(getChatFileExtraction as never, { fileId, ...(threadId && { threadId }), ...(unlockProof && { unlockProof }) } as never);

const proofFor = async (threadId: string) => {
    const { proof } = await mintUnlockProof({ epoch, threadId, userId: OWNER }, SECRET, Date.now());

    return proof;
};

beforeEach(() => {
    process.env.STORAGE_SIGNING_SECRET = SECRET;
    harness = lunoraTest(schema as never);
    epoch = newPasscodeEpoch();
});

describe("a locked chat indexed after the fact", () => {
    it("gates an attachment with no link until the chat is indexed, and only through the proof after", async () => {
        const threadId = await newThread(2);
        const fileId = await insertFile("legacy-1");

        await grant(fileId);
        await passcodeRow(threadId);
        await legacyMessage(threadId, 0, [fileId]);

        // Fallback: the file is in the locked chat's messages, so the grant alone does not serve it.
        await expect(readExtraction(fileId)).resolves.toBeNull();
        await expect(readExtraction(fileId, threadId, await proofFor(threadId))).resolves.toEqual({ status: "pending" });

        await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, { threadId: threadId as never }));
        await drainBackfill();

        // Indexed: the link answers, so the same refusal holds with the messages gone.
        await expect(linksOf(threadId)).resolves.toMatchObject([{ fileId, threadId, userId: OWNER }]);
        await dropMessages(threadId);
        await expect(readExtraction(fileId)).resolves.toBeNull();
        await expect(readExtraction(fileId, threadId, await proofFor(threadId))).resolves.toEqual({ status: "pending" });
    });

    it("walks every page of a long chat and stamps the row once, with each attachment linked", async () => {
        const threadId = await newThread(2);
        const count = BACKFILL_PAGE * 2 + 30;
        const first = await insertFile("page-first");
        const middle = await insertFile("page-middle");
        const last = await insertFile("page-last");

        await passcodeRow(threadId);

        const placed = new Map<number, string>([
            [0, first],
            [BACKFILL_PAGE + 50, middle],
            [count - 1, last],
        ]);

        for (let order = 0; order < count; order += 1) {
            const file = placed.get(order);

            await legacyMessage(threadId, order, file === undefined ? [] : [file]);
        }

        await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, { threadId: threadId as never }));

        expect(jobsFor("backfillChatFileLinks")).toHaveLength(1);
        expect(await drainBackfill()).toBe(2);

        const links = await linksOf(threadId);

        const byName = (a: string, b: string) => a.localeCompare(b);

        expect(links.map((link: { fileId: string }) => link.fileId).toSorted(byName)).toStrictEqual([first, last, middle].toSorted(byName));
        expect(await stampOf(threadId)).toBeTypeOf("number");
    });

    it("a re-run after the stamp does nothing: no step queued, no link changed, the stamp kept", async () => {
        const threadId = await newThread(2);
        const fileId = await insertFile("rerun-1");

        await passcodeRow(threadId);
        await legacyMessage(threadId, 0, [fileId]);
        await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, { threadId: threadId as never }));
        await drainBackfill();

        const stamp = await stampOf(threadId);
        const before = await linksOf(threadId);
        const queued = harness.scheduler.list().length;

        await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, { threadId: threadId as never }));

        expect(harness.scheduler.list()).toHaveLength(queued);
        expect(await linksOf(threadId)).toStrictEqual(before);
        expect(await stampOf(threadId)).toBe(stamp);
    });

    it("finds an attachment on the chat's newest message, past the first pages, before the chat is indexed", async () => {
        const threadId = await newThread(2);
        const fileId = await insertFile("newest-1");
        const newest = BACKFILL_PAGE * 2 + 5;

        await grant(fileId);
        await passcodeRow(threadId);

        for (let order = 0; order < newest; order += 1) {
            await legacyMessage(threadId, order);
        }

        await legacyMessage(threadId, newest, [fileId]);

        await expect(readExtraction(fileId)).resolves.toBeNull();
    });
});

describe("the unindexed-chat sweep and the triggers", () => {
    it("an unlocked chat's attachments are served and nothing is walked", async () => {
        const threadId = await newThread();
        const fileId = await insertFile("open-1");

        await grant(fileId);
        await legacyMessage(threadId, 0, [fileId]);

        await expect(readExtraction(fileId)).resolves.toEqual({ status: "pending" });

        await run(async (ctx) => await ctx.runMutation(backfillUnindexedFileLinks, {}));
        await run(async (ctx) => await ctx.runMutation(backfillChatFileLinks, { threadId: threadId as never }));

        expect(jobsFor("backfillChatFileLinks")).toHaveLength(0);
        await expect(linksOf(threadId)).resolves.toStrictEqual([]);
        await expect(rowOf(threadId)).resolves.toBeNull();
    });

    it("the sweep queues only the locked chats that are not indexed yet", async () => {
        const unindexed = await newThread(2);
        const indexed = await newThread(2);

        await passcodeRow(unindexed);
        await passcodeRow(indexed, 5);

        await run(async (ctx) => await ctx.runMutation(backfillUnindexedFileLinks, {}));

        const queued = jobsFor("backfillChatFileLinks");

        expect(queued).toHaveLength(1);
        expect(queued[0]?.args).toMatchObject({ threadId: unindexed });
    });

    it("locking a chat queues its walk", async () => {
        const threadId = await newThread();

        await as(OWNER).mutation(enableThreadLock as never, { passcode: PASSCODE, threadId } as never);

        expect(jobsFor("backfillChatFileLinks")).toHaveLength(1);
        expect(await stampOf(threadId)).toBeUndefined();
    });

    it("locking an unindexed chat again queues its walk, and an indexed one does not", async () => {
        const unindexed = await newThread(2);
        const indexed = await newThread(2);

        await passcodeRow(unindexed);
        await passcodeRow(indexed, 5);

        await as(OWNER).mutation(lockThread as never, { threadId: indexed } as never);
        expect(jobsFor("backfillChatFileLinks")).toHaveLength(0);

        await as(OWNER).mutation(lockThread as never, { threadId: unindexed } as never);
        expect(jobsFor("backfillChatFileLinks")).toHaveLength(1);
        expect(await stampOf(indexed)).toBe(5);
    });

    it("a branch's new passcode row queues the branch's walk", async () => {
        const source = await newThread(2);
        const target = await newThread(2);

        await passcodeRow(source, 5);
        await run(async (ctx) => await inheritPasscodeHandler(ctx, { sourceThreadId: source as never, targetThreadId: target as never }));

        expect(jobsFor("backfillChatFileLinks").map((job) => job.args)).toMatchObject([{ threadId: target }]);
        expect(await stampOf(target)).toBeUndefined();
    });
});
