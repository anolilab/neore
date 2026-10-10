/**
 * The messenger's media rows: a saved media message counts its files and
 * carries them as parts, and a reply's files are only handed back when the
 * thread's owner holds a grant for their storage.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import {
    claimThreadReply,
    completeMessengerMessage,
    listReplyMedia,
    MESSENGER_PENDING_STALE_MS,
    planThreadReply,
    saveMessengerMessage,
    threadHasRecentMedia,
} from "./functions";

const OWNER = "owner";
const HASH = "a".repeat(64);
const FOREIGN_HASH = "b".repeat(64);

let harness: ReturnType<typeof lunoraTest>;

const chatFile = async (hash: string, grantTo?: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const fileId = await ctx.db.insert("chatFiles", {
            extractionStatus: "pending",
            hash,
            lastTouchedAt: 0,
            mediaType: "image/png",
            refcount: 0,
            storageId: `agent-files/${hash}`,
        });

        if (grantTo) {
            await ctx.db.insert("chatFileAccess", { createdAt: 0, fileId, userId: grantTo });
        }

        return fileId;
    });

const thread = async (): Promise<string> =>
    await harness.run(async (ctx: any) => await ctx.db.insert("threads", { source: "telegram", status: "active", title: "Telegram Chat", userId: OWNER }));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("saveMessengerMessage", () => {
    it("saves the parts after the text, sets fileIds and counts each file", async () => {
        const threadId = await thread();
        const fileId = await chatFile(HASH, OWNER);

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(saveMessengerMessage, {
                    fileIds: [fileId],
                    parts: [{ image: `storage:agent-files/${HASH}`, mediaType: "image/png", type: "image" }],
                    text: "what is this?",
                    threadId,
                    userId: OWNER,
                }),
        );

        const [row] = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const file = await harness.run(async (ctx: any) => await ctx.db.chatFiles.findFirst({ where: { _id: fileId } }));

        expect(row.fileIds).toStrictEqual([fileId]);
        expect(row.message.content).toStrictEqual([
            { text: "what is this?", type: "text" },
            { image: `storage:agent-files/${HASH}`, mediaType: "image/png", type: "image" },
        ]);
        expect(file.refcount).toBe(1);
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(threadHasRecentMedia, { threadId }))).toBe(true);
    });
});

describe("listReplyMedia", () => {
    it("returns the reply's files after the last user message, only where the owner holds a grant", async () => {
        const threadId = await thread();

        await chatFile(HASH, OWNER);
        await chatFile(FOREIGN_HASH, "someone-else");

        await harness.run(async (ctx: any) => {
            const base = { status: "success", stepOrder: 0, threadId, tool: false, userId: OWNER };

            await ctx.db.insert("messages", {
                ...base,
                message: { content: [{ data: `storage:agent-files/${HASH}`, mediaType: "image/png", type: "file" }], role: "assistant" },
                order: 0,
            });
            await ctx.db.insert("messages", { ...base, message: { content: "hi", role: "user" }, order: 1 });
            await ctx.db.insert("messages", {
                ...base,
                message: {
                    content: [
                        { text: "here you go", type: "text" },
                        { data: `storage:agent-files/${HASH}`, filename: "chart.png", mediaType: "image/png", type: "file" },
                        { image: `storage:agent-files/${FOREIGN_HASH}`, mediaType: "image/png", type: "image" },
                    ],
                    role: "assistant",
                },
                order: 2,
            });
        });

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(listReplyMedia, { threadId, userId: OWNER }))).toStrictEqual([
            { filename: "chart.png", key: `agent-files/${HASH}`, mediaType: "image/png" },
        ]);
    });
});

describe("photo, then text", () => {
    const save = async (threadId: string, text: string, pending = false): Promise<string> =>
        (
            (await harness.run(
                async (ctx: any) => await ctx.runMutation(saveMessengerMessage, { ...(pending && { pending: true }), text, threadId, userId: OWNER }),
            )) as {
                messageId: string;
            }
        ).messageId;
    const claim = async (threadId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(claimThreadReply, { threadId, userId: OWNER }));

    it("keeps arrival order, holds every reply while the photo is stored, then answers both once", async () => {
        const threadId = await thread();
        const photo = await save(threadId, "look", true);
        const text = await save(threadId, "what breed is it?");

        // The text's reply action ran first: the photo is still pending, so it waits.
        await expect(claim(threadId)).resolves.toStrictEqual({ claimed: false });

        const fileId = await chatFile(HASH, OWNER);

        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(completeMessengerMessage, {
                    fileIds: [fileId],
                    messageId: photo,
                    parts: [{ image: `storage:agent-files/${HASH}`, mediaType: "image/png", type: "image" }],
                    text: "look",
                }),
        );

        // The photo's action answers the newest message — the text — once.
        await expect(claim(threadId)).resolves.toStrictEqual({ claimed: true, newestUserMessageId: text });
        await expect(claim(threadId)).resolves.toStrictEqual({ claimed: false });

        const rows = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("messages")
                    .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                    .collect(),
        );

        expect(rows.map((row: { status: string; text: string }) => [row.text, row.status])).toStrictEqual([
            ["look", "completed"],
            ["what breed is it?", "completed"],
        ]);
        expect(rows[0].message.content).toContainEqual({ image: `storage:agent-files/${HASH}`, mediaType: "image/png", type: "image" });
    });

    it("stops waiting for a media message whose reply action died", () => {
        const now = 10 * MESSENGER_PENDING_STALE_MS;
        const user = (id: string, status: string, createdAt: number) => {
            return { _creationTime: createdAt, _id: id, message: { role: "user" }, status };
        };

        expect(planThreadReply([user("t", "completed", now), user("p", "pending", now - 1000)], now)).toStrictEqual({ waitFor: "pending-media" });
        expect(planThreadReply([user("t", "completed", now), user("p", "pending", now - MESSENGER_PENDING_STALE_MS - 1)], now)).toStrictEqual({
            newestUserMessageId: "t",
        });
        expect(planThreadReply([], now)).toBeUndefined();
    });
});
