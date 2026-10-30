/**
 * The coding-agent part of the account export and erasure. The export pages (`next` until none) so a long history
 * is complete and no page holds more than a bounded amount; erasure reaches the host streams, their event chunks
 * and the sessions of the user it is run for, and no one else's.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { erasePersistentStreamsForUser } from "../chat/gdpr";
import schema from "../schema";
import { collectAcpSessionsForExport, deleteUserAcpSessions } from "./gdpr";

const A = "user-a";
const B = "user-b";

type Harness = ReturnType<typeof lunoraTest>;
type Cursor = { page?: string; phase: "events" | "sessions"; seq?: number };
type Page = { events: { event: Record<string, any>; seq: number; threadId: string; turnId: string }[]; next?: Cursor; sessions: Record<string, any>[] };

let harness: Harness;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insertDevice = async (userId: string) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("devices", { createdAt: 0, encryptedSecret: "x", name: "Laptop", platform: "linux", userId }),
    )) as string;

const insertSession = async (userId: string, deviceId: string, index: number) =>
    await harness.run(async (ctx: any) => {
        const threadId = await ctx.db.insert("threads", { runner: "host", status: "active", title: `T${String(index)}`, userId });

        await ctx.db.insert("acpSessions", {
            agentKey: "claude",
            agentLabel: "Claude Code",
            createdAt: index,
            deviceId,
            folderId: "f",
            folderLabel: "neore",
            hostSessionId: `h${String(index)}`,
            status: "idle",
            threadId,
            updatedAt: index,
            userId,
        });

        return threadId as string;
    });

/** A host stream with `count` chunks: a prompt, then text chunks with a tool event after every `every`th one. */
const insertTurn = async (userId: string, threadId: string, turnId: string, count: number, every = 2) =>
    await harness.run(async (ctx: any) => {
        const streamId = await ctx.db.insert("persistentStreams", {
            expiresAt: 0,
            hostTurnId: turnId,
            messageId: "m",
            producer: "host",
            status: "done",
            streamingConfig: { contentType: "text", model: "host" },
            threadId,
            userId,
        });

        await ctx.db.insert("persistentChunks", { event: { kind: "turn_start", text: "" }, seq: 0, streamId, text: "" });

        for (let seq = 1; seq < count; seq += 1) {
            await ctx.db.insert(
                "persistentChunks",
                seq % every === 0
                    ? { event: { id: `tool${String(seq)}`, kind: "tool", status: "completed", title: "Read file", toolKind: "read" }, seq, streamId, text: "" }
                    : { seq, streamId, text: "words" },
            );
        }

        return streamId as string;
    });

const collectPage = async (userId: string, cursor?: Cursor): Promise<Page> =>
    (await harness.run(async (ctx: any) => await ctx.runQuery(collectAcpSessionsForExport, { userId, ...(cursor && { cursor }) }))) as Page;

/** The workflow's loop: pages until there is no `next`. */
const collectAll = async (userId: string) => {
    const pages: Page[] = [];
    let cursor: Cursor | undefined;

    for (let round = 0; round < 200; round += 1) {
        const page = await collectPage(userId, cursor);

        pages.push(page);

        if (!page.next) {
            return pages;
        }

        cursor = page.next;
    }

    throw new Error("the export did not end");
};

describe("the export of coding-agent sessions and events", () => {
    it("is complete past one page of sessions, and carries no other user's", async () => {
        const device = await insertDevice(A);
        const other = await insertDevice(B);

        for (let index = 0; index < 1100; index += 1) {
            await insertSession(A, device, index);
        }

        await insertSession(B, other, 0);

        const pages = await collectAll(A);
        const sessions = pages.flatMap((page) => page.sessions);

        expect(pages.length).toBeGreaterThan(2);
        expect(sessions).toHaveLength(1100);
        expect(new Set(sessions.map((session) => session.threadId)).size).toBe(1100);
        expect(sessions[0]).not.toHaveProperty("deviceId");
        expect(sessions[0]).not.toHaveProperty("folderId");
    });

    it("pages a user's tool and permission events across streams, each exactly once and in order", async () => {
        const device = await insertDevice(A);
        const threadA = await insertSession(A, device, 0);
        const threadB = await insertSession(A, device, 1);
        const otherThread = await insertSession(B, await insertDevice(B), 0);

        // 3 streams of ~700 chunks: far past one scan budget, so the walk has to resume inside a stream.
        await insertTurn(A, threadA, "t1", 700);
        await insertTurn(A, threadA, "t2", 700);
        await insertTurn(A, threadB, "t3", 700);
        await insertTurn(B, otherThread, "other", 700);

        const pages = await collectAll(A);
        const events = pages.flatMap((page) => page.events);
        const perTurn = (turnId: string) => events.filter((entry) => entry.turnId === turnId);

        expect(pages.filter((page) => page.events.length > 0).length).toBeGreaterThan(1);

        // 699 chunks after the prompt, every second one an event.
        for (const turnId of ["t1", "t2", "t3"]) {
            const seqs = perTurn(turnId).map((entry) => entry.seq);

            expect(seqs).toHaveLength(349);
            expect(seqs).toEqual(seqs.toSorted((left, right) => left - right));
            expect(new Set(seqs).size).toBe(seqs.length);
        }

        expect(perTurn("other")).toHaveLength(0);
        // Text chunks are the saved reply's; the prompt is the user's message. Neither is repeated here.
        expect(events.every((entry) => entry.event.kind === "tool")).toBe(true);
        expect(perTurn("t1")[0]?.threadId).toBe(threadA);
        expect(perTurn("t3")[0]?.threadId).toBe(threadB);
    });

    it("bounds a page by the bytes of the events it returns, and still makes progress on a huge one", async () => {
        const device = await insertDevice(A);
        const threadId = await insertSession(A, device, 0);

        await harness.run(async (ctx: any) => {
            const streamId = await ctx.db.insert("persistentStreams", {
                expiresAt: 0,
                hostTurnId: "big",
                messageId: "m",
                producer: "host",
                status: "done",
                streamingConfig: { contentType: "text", model: "host" },
                threadId,
                userId: A,
            });

            for (let seq = 0; seq < 120; seq += 1) {
                await ctx.db.insert("persistentChunks", {
                    event: { command: "x".repeat(9000), kind: "permission_request", options: [], requestId: `r${String(seq)}`, tool: "shell" },
                    seq,
                    streamId,
                    text: "",
                });
            }
        });

        const pages = await collectAll(A);
        const events = pages.flatMap((page) => page.events);

        expect(events).toHaveLength(120);
        expect(pages.length).toBeGreaterThan(2);

        for (const page of pages) {
            expect(JSON.stringify(page.events).length).toBeLessThan(500_000);
        }
    });

    it("is one empty page for a user with no agent history", async () => {
        const pages = await collectAll(A);

        expect(pages.flatMap((page) => [...page.sessions, ...page.events])).toEqual([]);
    });
});

describe("erasing a user's coding-agent data", () => {
    it("removes their host streams, every event chunk and their sessions, and no one else's", async () => {
        const device = await insertDevice(A);
        const other = await insertDevice(B);
        const threadA = await insertSession(A, device, 0);
        const threadB = await insertSession(B, other, 0);
        const streamA = await insertTurn(A, threadA, "t1", 600);
        const streamB = await insertTurn(B, threadB, "t2", 5);

        for (let round = 0; round < 50; round += 1) {
            const { hasMore } = (await harness.run(async (ctx: any) => await erasePersistentStreamsForUser(ctx, A))) as { hasMore: boolean };

            if (!hasMore) {
                break;
            }
        }

        await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserAcpSessions, { userId: A }));

        const count = async (table: string, where: Record<string, unknown>) =>
            (await harness.run(async (ctx: any) => {
                const { page } = await ctx.db[table].findMany({ where });

                return page.length;
            })) as number;

        expect(await count("persistentStreams", { userId: A })).toBe(0);
        expect(await count("persistentChunks", { streamId: streamA })).toBe(0);
        expect(await count("acpSessions", { userId: A })).toBe(0);
        expect(await count("persistentStreams", { userId: B })).toBe(1);
        expect(await count("persistentChunks", { streamId: streamB })).toBe(5);
        expect(await count("acpSessions", { userId: B })).toBe(1);
    });
});
