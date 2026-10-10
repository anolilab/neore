/**
 * What the hot read paths cost the database: the sidebar's and thread page's
 * first-paint queries, the branch walk and the per-page attachment lookups.
 * They run on every `/chat` load and the live ones re-run whenever a write
 * touches a range they read, so their statement and row counts are pinned
 * here (`test/db-cost.ts` counts them).
 *
 * Three traps this guards, each measured before its fix:
 *
 * - Under row-level security the legacy `ctx.db.query(t).withIndex(…)` builder
 *   filtered in memory and dropped the SQL LIMIT: `take(5)` read a user's
 *   whole index range. With 600 threads `getThreadListData` read ~1,230 rows in
 *   37 statements. Fixed upstream in `@lunora/server@alpha.145`
 *   (anolilab/lunora#822); these paths use the ORM facade
 *   (`ctx.db.<table>.findMany`) or read an admitted thread's rows past the
 *   policy (`readerForAdmittedThread`) either way.
 * - An un-hinted `ctx.db.get(id)` probes every table (a UNION over all of them)
 *   and then re-reads the row under the policy: three statements per temporary
 *   thread, which the list now fetches in one `in` read.
 * - A read per id on a `.global()` table is a D1 round trip each deployed;
 *   attachment and ownership lookups now read a page's ids at once.
 */
import { lunoraTest } from "@lunora/testing";
import { describe, expect, it, vi } from "vitest";

import { measureDb } from "../../test/db-cost";
import { signDocsForDisplay } from "../agent/display-media";
import { listThreadsByProject } from "../agent/projects";
import { listThreadsByUserId } from "../agent/threads";
import { ownedStorageKeys } from "../lib/storage-ownership";
import schema from "../schema";
import { getThreadListData, getThreadWithData } from "./composite";
import { getThreadUIMessages } from "./functions";
import { loadNsfwStatuses } from "./lib/public-thread";
import { getActiveStreamForThread } from "./streaming";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
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

const OWNER = "user-owner";
const OTHER = "user-other";
const THREADS = 600;
const TEMPORARY = 10;
const PINNED = 5;
const MESSAGES = 300;

const seed = async (harness: ReturnType<typeof lunoraTest>) =>
    await harness.run(async (context: any) => {
        const ids: string[] = [];

        for (let index = 0; index < THREADS; index += 1) {
            const isTemporary = index >= THREADS - TEMPORARY;
            const threadId = await context.db.insert("threads", {
                deleted: index === 7,
                model: "m",
                // Only every other thread was ever reordered by hand.
                ...(index % 2 === 0 && { order: index }),
                ...(index < PINNED && { pinnedAt: 100 - index }),
                ...(isTemporary && { isTemporary: true }),
                status: "active",
                title: `t${String(index)}`,
                userId: OWNER,
            });

            if (isTemporary) {
                await context.db.insert("temporaryThreads", { expiresAt: Date.now() + 60_000 * (THREADS - index), threadId, userId: OWNER });
            }

            ids.push(threadId);
        }

        // Someone else's rows must neither show up nor be read.
        await context.db.insert("threads", { model: "m", order: 0, pinnedAt: 1, status: "active", title: "theirs", userId: OTHER });
        await context.db.insert("threadRelationships", { branchType: "branch", createdAt: 1, parentThreadId: ids[0], threadId: ids[1], userId: OWNER });
        await context.db.insert("threadTags", { color: "red", name: "work", order: 0, userId: OWNER });
        await context.db.insert("followupSuggestions", { lastMessageId: "m-last", suggestions: ["next?"], threadId: ids[0] });

        for (let index = 0; index < MESSAGES; index += 1) {
            const isReply = index % 2 === 1;

            await context.db.insert("messages", {
                message: { content: `m${String(index)}`, role: isReply ? "assistant" : "user" },
                order: Math.floor(index / 2),
                status: "success",
                stepOrder: isReply ? 1 : 0,
                text: `m${String(index)}`,
                threadId: ids[0],
                tool: false,
                ...(isReply && { usage: { completionTokens: 2, promptTokens: 3, totalTokens: 5 } }),
                userId: OWNER,
            });
        }

        return ids;
    });

describe("thread list and thread page cost", () => {
    it("getThreadListData reads each list once, bounded, in parallel", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const ids = await seed(harness);
            const { cost, result } = await measureDb(
                async () => (await harness.withIdentity({ userId: OWNER }).query(getThreadListData as never, {} as never)) as any,
            );

            // The page: the first 100 of the `by_user_and_status` walk (the
            // deleted thread sorts first), minus the deleted and temporary ones.
            expect(result.threads.page).toHaveLength(100 - 1 - TEMPORARY);
            expect(result.threads.page.every((thread: any) => thread.userId === OWNER && !thread.isTemporary && !thread.deleted)).toBe(true);
            expect(result.temporaryThreads.page.map((thread: any) => thread._id)).toEqual(ids.slice(THREADS - TEMPORARY).toReversed());
            expect(result.pinnedThreads.map((thread: any) => thread.pinnedAt)).toEqual([96, 97, 98, 99, 100]);
            // Every hand-ordered thread but the deleted one, never crowded out by unordered ones.
            expect(result.threadOrders).toHaveLength(THREADS / 2);
            expect(result.threadOrders.map((thread: any) => thread.order)).toEqual(
                result.threadOrders.map((thread: any) => thread.order).toSorted((a: number, b: number) => a - b),
            );
            expect(result.relationships).toEqual([{ branchPoint: undefined, branchType: "branch", createdAt: 1, parentThreadId: ids[0], threadId: ids[1] }]);
            expect(result.tags).toMatchObject([{ color: "red", name: "work", order: 0 }]);

            // Was 37 statements (10 temporary threads × 3 for an un-hinted get,
            // plus a `count()`) and ~1,230 rows (every list read the whole range).
            expect(cost.statements, JSON.stringify(cost.byTable)).toBe(7);
            // 101 (page + lookahead) + 10 + 10 temporary + 5 pinned + 300 ordered + 1 + 1.
            expect(cost.rowsRead).toBe(428);
        } finally {
            harness.close();
        }
    });

    it("getThreadWithData reads usage off the usage rows only", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const [threadId] = await seed(harness);
            const { cost, result } = await measureDb(
                async () => (await harness.withIdentity({ userId: OWNER }).query(getThreadWithData as never, { threadId } as never)) as any,
            );

            expect(result.usage).toEqual({ cachedInputTokens: 0, inputTokens: 450, outputTokens: 300, reasoningTokens: 0, totalTokens: 750 });
            expect(result.suggestions).toEqual({ lastMessageId: "m-last", suggestions: ["next?"] });
            expect(result.messages.page).toHaveLength(10);

            // The usage scan used to read all 300 messages (content included);
            // now it reads the 150 that carry usage. The page read reads its
            // page: the thread is admitted, so it goes past the policy
            // (`readerForAdmittedThread`), which behind `rls()` read all 300.
            expect(cost.byTable.messages).toBe(2);
            // 11 (the page + lookahead) + 150 (usage) + 1 (suggestions) + 1 (the thread).
            expect(cost.rowsRead).toBe(163);
        } finally {
            harness.close();
        }
    });

    it("a linear thread's page reads its page, for the owner and for a grantee", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const [threadId] = await seed(harness);

            await harness.run(async (context: any) => {
                await context.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, ownerId: OWNER, permission: "read", threadId, userId: OTHER });
            });

            const pageOf = async (userId: string) =>
                await measureDb(
                    async () =>
                        (await harness
                            .withIdentity({ userId })
                            .query(getThreadUIMessages as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId } as never)) as any,
                );
            const owner = await pageOf(OWNER);
            const grantee = await pageOf(OTHER);

            expect(grantee.result.page.map((message: any) => message.id)).toEqual(owner.result.page.map((message: any) => message.id));
            expect(owner.result.page.length).toBeGreaterThan(0);

            for (const { cost } of [owner, grantee]) {
                // Was all 300 of the thread's messages behind `rls()`.
                expect(cost.rowsRead, JSON.stringify(cost.byTable)).toBeLessThan(40);
            }
        } finally {
            harness.close();
        }
    });

    it("a branched thread's page costs about its size, however long the thread", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const threadId = await harness.run(async (context: any) => {
                const thread = await context.db.insert("threads", { model: "m", status: "active", title: "branched", userId: OWNER });
                let prompt: string | undefined;
                let leaf: string | undefined;

                for (let index = 0; index < 400; index += 1) {
                    const isReply = index % 2 === 1;

                    leaf = await context.db.insert("messages", {
                        message: { content: `m${String(index)}`, role: isReply ? "assistant" : "user" },
                        order: Math.floor(index / 2),
                        status: "success",
                        stepOrder: isReply ? 1 : 0,
                        text: `m${String(index)}`,
                        threadId: thread,
                        tool: false,
                        userId: OWNER,
                    });
                    prompt ??= leaf;
                }

                // A regenerated first reply makes the thread branched.
                await context.db.insert("messages", {
                    message: { content: "alt", role: "assistant" },
                    order: 0,
                    parentMessageId: prompt,
                    status: "success",
                    stepOrder: 2,
                    text: "alt",
                    threadId: thread,
                    tool: false,
                    userId: OWNER,
                });
                await context.db.patch(thread, { activeLeafMessageId: leaf });

                return thread;
            });
            const { cost, result } = await measureDb(
                async () =>
                    (await harness
                        .withIdentity({ userId: OWNER })
                        .query(getThreadUIMessages as never, { paginationOpts: { cursor: null, numItems: 10 }, threadId } as never)) as any,
            );

            expect(result.page).toHaveLength(10);
            expect(result.continueCursor.startsWith("branch:")).toBe(true);

            // Was 829 rows at 400 messages (and 229 at 100): each `.first()` of
            // the walk read the rest of the thread. Now the same at any length.
            expect(cost.rowsRead).toBe(29);
            expect(cost.statements, JSON.stringify(cost.byTable)).toBeLessThanOrEqual(35);
        } finally {
            harness.close();
        }
    });

    it("getActiveStreamForThread reads the live stream, not every stream the thread had", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const { live, threadId } = await harness.run(async (context: any) => {
                const thread = await context.db.insert("threads", { model: "m", status: "active", title: "streams", userId: OWNER });
                const stream = (status: string) => {
                    return {
                        expiresAt: Date.now() + 60_000,
                        messageId: "m",
                        status,
                        streamingConfig: { contentType: "text", model: "m" },
                        threadId: thread,
                        userId: OWNER,
                    };
                };

                for (let index = 0; index < 50; index += 1) {
                    await context.db.insert("persistentStreams", stream("done"));
                }

                return { live: await context.db.insert("persistentStreams", stream("streaming")), threadId: thread };
            });
            const { cost, result } = await measureDb(
                async () => await harness.withIdentity({ userId: OWNER }).query(getActiveStreamForThread as never, { threadId } as never),
            );

            expect(result).toEqual({ streamId: live });
            // Was 51: the status test ran in memory over every stream of the thread.
            expect(cost.byTable.persistentStreams).toBe(1);
            expect(cost.rowsRead).toBeLessThanOrEqual(2);
        } finally {
            harness.close();
        }
    });

    it("a page's attachments are looked up in one `chatFiles` read each, not one per file", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const fileIds: string[] = await harness.run(async (context: any) => {
                const ids: string[] = [];

                for (let index = 0; index < 8; index += 1) {
                    ids.push(
                        await context.db.insert("chatFiles", {
                            hash: `h${String(index)}`,
                            lastTouchedAt: 0,
                            mediaType: "image/png",
                            nsfwStatus: index === 3 ? "blocked" : "safe",
                            refcount: 1,
                            storageId: `agent-files/key-${String(index)}`,
                        }),
                    );
                }

                return ids;
            });
            const messages = fileIds.map((fileId) => {
                return { metadata: { fileIds: [fileId, "missing-file"] } };
            });
            const docs = fileIds.map((fileId) => {
                return { fileIds: [fileId], message: { content: "no media", role: "user" } };
            });

            const nsfw = await measureDb(async () => await harness.run(async (context: any) => await loadNsfwStatuses(context, messages as never)));
            const signed = await measureDb(async () => await harness.run(async (context: any) => await signDocsForDisplay(context, docs as never)));

            expect(nsfw.result.get(fileIds[3]!)).toBe("blocked");
            expect(nsfw.result.get(fileIds[0]!)).toBe("safe");
            expect(nsfw.result.has("missing-file")).toBe(false);
            expect(signed.result).toEqual(docs);
            // Each was 8 statements, every one a D1 round trip deployed.
            expect(nsfw.cost.byTable).toEqual({ chatFiles: 1 });
            expect(signed.cost.byTable).toEqual({ chatFiles: 1 });
        } finally {
            harness.close();
        }
    });

    it("ownedStorageKeys decides a page of keys in three reads", async () => {
        const harness = lunoraTest(schema as never);
        const hash = (index: number) => String(index).padStart(64, "0");
        const chatKey = (index: number) => `agent-files/${hash(index)}`;

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < 5; index += 1) {
                    const fileId = await context.db.insert("chatFiles", {
                        hash: hash(index),
                        lastTouchedAt: 0,
                        mediaType: "image/png",
                        refcount: 1,
                        storageId: chatKey(index),
                    });

                    // Granted to the owner for 0-2, to someone else for 3-4.
                    await context.db.insert("chatFileAccess", { fileId, userId: index < 3 ? OWNER : OTHER });
                }

                await context.db.insert("files", { key: "vault/mine", name: "a", size: 1, type: "image/png", userId: OWNER });
                await context.db.insert("files", { key: "vault/theirs", name: "b", size: 1, type: "image/png", userId: OTHER });
            });

            const keys = [...[0, 1, 2, 3, 4].map((index) => chatKey(index)), "vault/mine", "vault/theirs", "vault/nobody", chatKey(9)];
            const { cost, result } = await measureDb(async () => await harness.run(async (context: any) => await ownedStorageKeys(context.db, OWNER, keys)));

            expect(result).toEqual(new Set([chatKey(0), chatKey(1), chatKey(2), "vault/mine"]));
            // Was one chain per key: 9 keys, up to 3 reads each, grants sequential.
            expect(cost.byTable).toEqual({ chatFileAccess: 1, chatFiles: 1, files: 1 });
        } finally {
            harness.close();
        }
    });

    it("listThreadsByUserId reads one page, on each of its three index walks", async () => {
        const harness = lunoraTest(schema as never);

        try {
            await harness.run(async (context: any) => {
                for (let index = 0; index < 300; index += 1) {
                    await context.db.insert("threads", {
                        model: "m",
                        // A third personal, a third in the org, a third in its team.
                        ...(index % 3 !== 0 && { organizationId: "org-1" }),
                        ...(index % 3 === 2 && { teamId: "team-1" }),
                        status: "active",
                        title: `t${String(index)}`,
                        userId: OWNER,
                    });
                }
            });

            const as = harness.withIdentity({ userId: OWNER });
            const page = { cursor: null, numItems: 20 };
            const personal = await measureDb(
                async () => (await as.query(listThreadsByUserId as never, { organizationId: null, paginationOpts: page } as never)) as any,
            );
            const org = await measureDb(
                async () => (await as.query(listThreadsByUserId as never, { organizationId: "org-1", paginationOpts: page } as never)) as any,
            );
            const team = await measureDb(
                async () => (await as.query(listThreadsByUserId as never, { paginationOpts: page, teamId: "team-1" } as never)) as any,
            );
            const all = await measureDb(async () => (await as.query(listThreadsByUserId as never, { paginationOpts: page } as never)) as any);

            expect(personal.result.page.every((thread: any) => thread.organizationId === undefined)).toBe(true);
            expect(org.result.page.every((thread: any) => thread.organizationId === "org-1")).toBe(true);
            expect(team.result.page.every((thread: any) => thread.teamId === "team-1")).toBe(true);

            for (const { cost, result } of [personal, org, team, all]) {
                expect(result.page).toHaveLength(20);
                expect(result.isDone).toBe(false);
                // Was the caller's whole index range: 100 to 300 rows here.
                expect(cost).toMatchObject({ rowsRead: 21, statements: 1 });
            }

            // The cursor continues exactly where the page stopped.
            const next: any = await as.query(listThreadsByUserId as never, { paginationOpts: { cursor: all.result.continueCursor, numItems: 20 } } as never);
            const both: any = await as.query(listThreadsByUserId as never, { paginationOpts: { cursor: null, numItems: 40 } } as never);

            expect([...all.result.page, ...next.page].map((thread: any) => thread._id)).toEqual(both.page.map((thread: any) => thread._id));
        } finally {
            harness.close();
        }
    });

    it("listThreadsByProject reads one page of the project's threads", async () => {
        const harness = lunoraTest(schema as never);

        try {
            const projectId = await harness.run(async (context: any) => {
                const project = await context.db.insert("projects", { createdAt: 0, title: "p", userId: OWNER });

                for (let index = 0; index < 200; index += 1) {
                    await context.db.insert("threads", { model: "m", projectId: project, status: "active", title: `t${String(index)}`, userId: OWNER });
                }

                return project;
            });
            const as = harness.withIdentity({ userId: OWNER });
            const first = await measureDb(
                async () => (await as.query(listThreadsByProject as never, { paginationOpts: { cursor: null, numItems: 20 }, projectId } as never)) as any,
            );
            const next: any = await as.query(
                listThreadsByProject as never,
                { paginationOpts: { cursor: first.result.continueCursor, numItems: 20 }, projectId } as never,
            );
            const both: any = await as.query(listThreadsByProject as never, { paginationOpts: { cursor: null, numItems: 40 }, projectId } as never);

            expect(first.result.page).toHaveLength(20);
            expect(first.result.isDone).toBe(false);
            // Newest first.
            expect(first.result.page.map((thread: any) => thread._creationTime)).toEqual(
                first.result.page.map((thread: any) => thread._creationTime).toSorted((a: number, b: number) => b - a),
            );
            expect([...first.result.page, ...next.page].map((thread: any) => thread._id)).toEqual(both.page.map((thread: any) => thread._id));
            // Was all 200 behind `rls()`: the project row, then the page and its lookahead.
            expect(first.cost.rowsRead, JSON.stringify(first.cost.byTable)).toBeLessThanOrEqual(1 + 21);
            // Someone else sees none of it.
            expect(((await harness.withIdentity({ userId: OTHER }).query(listThreadsByProject as never, { projectId } as never)) as any).page).toEqual([]);
        } finally {
            harness.close();
        }
    });
});
