/**
 * The account-deletion steps that grow with a user's history (a stream and its
 * chunks per reply, document versions) delete in batches: each call removes
 * at most `BATCH` rows per table and reports `{ hasMore }`, and the workflow
 * drains it. More than one batch of everything here, for user A only.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { schemaWithShardedTables } from "../../lib/test-schema";
import {
    deleteParentsWithChildren,
    deleteUserDocuments,
    deleteUserFiles,
    deleteUserPersistentStreams,
    deleteUserThreadCascade,
    THREAD_CASCADE_PAGE,
} from "./deletion-steps";
import { BATCH } from "./residual-deletion-steps";

const A = "user-a";
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    // `threadInvites` is `.global()`, which the harness can only hold sharded.
    harness = lunoraTest(schemaWithShardedTables(["threadInvites"]) as never);
});

afterEach(() => {
    harness.close();
});

/** A minimal `vToolRunConfig`, as in `home/overview.test.ts`. */
const CONFIG = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: [],
};

const stream = (userId: string) => {
    return { expiresAt: 0, messageId: "m", status: "done", streamingConfig: { contentType: "text", model: "m" }, threadId: "t", userId };
};

const count = async (table: string, where: Record<string, unknown>): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db[table].findMany({ where });

        return page.length;
    });

/** The workflow's drain, minus the durable step: rounds until `hasMore` is false. */
const drain = async (step: unknown, userId: string): Promise<number> => {
    for (let round = 1; round <= 50; round += 1) {
        const { hasMore } = (await harness.run(async (ctx: any) => await ctx.runMutation(step, { userId }))) as { hasMore: boolean };

        if (!hasMore) {
            return round;
        }
    }

    throw new Error("did not drain");
};

describe("batched account-deletion steps", () => {
    it("deletes more than one batch of streams, of one stream's chunks, and of approval runs", async () => {
        const [bigStream, otherStream] = await harness.run(async (ctx: any) => {
            const ids: string[] = [];

            for (let index = 0; index < BATCH + 3; index += 1) {
                ids.push(await ctx.db.insert("persistentStreams", stream(A)));
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: `a${String(index)}`,
                    config: CONFIG,
                    createdAt: 0,
                    status: "pending",
                    threadId: "t",
                    userId: A,
                });
            }

            for (let seq = 0; seq < BATCH * 2 + 5; seq += 1) {
                await ctx.db.insert("persistentChunks", { seq, streamId: ids[0], text: "x" });
            }

            const other = await ctx.db.insert("persistentStreams", stream(B));

            await ctx.db.insert("persistentChunks", { seq: 0, streamId: other, text: "y" });

            return [ids[0], other];
        });

        expect(await drain(deleteUserPersistentStreams, A)).toBeGreaterThan(2);

        expect(await count("persistentStreams", { userId: A })).toBe(0);
        expect(await count("persistentChunks", { streamId: bigStream })).toBe(0);
        expect(await count("toolApprovalRuns", { userId: A })).toBe(0);
        expect(await count("persistentStreams", { userId: B })).toBe(1);
        expect(await count("persistentChunks", { streamId: otherStream })).toBe(1);
    });

    it("deletes more than one batch of vault files, then the folders", async () => {
        await harness.run(async (ctx: any) => {
            const folderId = await ctx.db.insert("folders", { createdAt: 0, name: "Docs", updatedAt: 0, userId: A });

            for (let index = 0; index < BATCH + 3; index += 1) {
                await ctx.db.insert("files", { folderId, key: `k-${String(index)}`, name: "f", size: 1, type: "text/plain", userId: A });
            }

            await ctx.db.insert("files", { key: "k-b", name: "f", size: 1, type: "text/plain", userId: B });
        });

        expect(await drain(deleteUserFiles, A)).toBeGreaterThan(2);
        expect(await count("files", { userId: A })).toBe(0);
        expect(await count("folders", { userId: A })).toBe(0);
        expect(await count("files", { userId: B })).toBe(1);
    });

    it("deletes a document with more versions than one batch, then the document", async () => {
        const documentId = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", { status: "active", title: "t", userId: A });
            const id = await ctx.db.insert("documents", { kind: "text", threadId, title: "Doc", userId: A, version: 1 });

            for (let version = 0; version < BATCH + 10; version += 1) {
                await ctx.db.insert("documentVersions", { createdAt: 0, documentId: id, userId: A, version });
            }

            return id;
        });

        expect(await drain(deleteUserDocuments, A)).toBe(2);
        expect(await count("documentVersions", { documentId })).toBe(0);
        expect(await count("documents", { userId: A })).toBe(0);
    });

    it("walks more than one page of threads with a cursor, revisiting a thread whose children fill a batch", async () => {
        const threadCount = THREAD_CASCADE_PAGE * 2 + 3;
        const { crowded, others } = await harness.run(async (ctx: any) => {
            const ids: string[] = [];

            for (let index = 0; index < threadCount; index += 1) {
                const threadId = await ctx.db.insert("threads", { status: "active", title: `t${String(index)}`, userId: A });

                ids.push(threadId);
                await ctx.db.insert("followupSuggestions", { createdAt: 0, lastMessageId: "m", suggestions: ["next?"], threadId, updatedAt: 0 });
                await ctx.db.insert("threadInvites", {
                    expiresAt: 0,
                    invitedBy: A,
                    invitedEmail: "x@example.com",
                    inviteToken: `tok-${String(index)}`,
                    permission: "read",
                    status: "pending",
                    threadId,
                });
            }

            // One thread with more suggestions than a batch.
            for (let index = 0; index < BATCH + 4; index += 1) {
                await ctx.db.insert("followupSuggestions", { createdAt: 0, lastMessageId: "m", suggestions: [], threadId: ids[1], updatedAt: 0 });
            }

            const otherThread = await ctx.db.insert("threads", { status: "active", title: "b", userId: B });

            await ctx.db.insert("followupSuggestions", { createdAt: 0, lastMessageId: "m", suggestions: [], threadId: otherThread, updatedAt: 0 });

            return { crowded: ids[1], others: otherThread };
        });

        let cursor: string | null = null;
        let rounds = 0;

        for (; rounds < 50; rounds += 1) {
            const result = (await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserThreadCascade, { cursor, userId: A }))) as {
                cursor: string | null;
                hasMore: boolean;
            };

            if (!result.hasMore) {
                break;
            }

            ({ cursor } = result);
        }

        // Three pages, plus one revisit of the crowded thread's page.
        expect(rounds + 1).toBeGreaterThanOrEqual(4);

        const remaining = await harness.run(async (ctx: any) => {
            const suggestions = await ctx.db.query("followupSuggestions").collect();
            const { page: invites } = await ctx.db.threadInvites.findMany({});

            return { invites: invites.length, suggestionThreads: suggestions.map((row: { threadId: string }) => row.threadId) };
        });

        expect(remaining).toStrictEqual({ invites: 0, suggestionThreads: [others] });
        expect(await count("followupSuggestions", { threadId: crowded })).toBe(0);
        // The threads themselves stay for the later step, which deletes them with their messages.
        expect(await count("threads", { userId: A })).toBe(threadCount);
    });

    it("deletes a full batch of an AUDITED child table through the shared helper", async () => {
        // `files` and `folders` carry audit triggers; deleting a batch of them
        // in parallel exceeds the 50-level trigger-recursion limit.
        const { folderId, remaining } = await harness.run(async (ctx: any) => {
            const folder = await ctx.db.insert("folders", { createdAt: 0, name: "Docs", updatedAt: 0, userId: A });

            for (let index = 0; index < BATCH; index += 1) {
                await ctx.db.insert("files", { folderId: folder, key: `k-${String(index)}`, name: "f", size: 1, type: "text/plain", userId: A });
            }

            const parent = await ctx.db.get(folder);
            const firstPass = await deleteParentsWithChildren(ctx, [parent], async () => {
                const { page } = await ctx.db.files.findMany({ limit: BATCH, where: { folderId: folder } });

                return page;
            });
            const secondPass = await deleteParentsWithChildren(ctx, [parent], async () => {
                const { page } = await ctx.db.files.findMany({ limit: BATCH, where: { folderId: folder } });

                return page;
            });

            return { folderId: folder, remaining: [firstPass, secondPass] };
        });

        // A full batch of children means "come back"; the second pass finds none and takes the folder.
        expect(remaining).toStrictEqual([true, false]);
        expect(await count("files", { folderId })).toBe(0);
        expect(await count("folders", { userId: A })).toBe(0);
    });
});
