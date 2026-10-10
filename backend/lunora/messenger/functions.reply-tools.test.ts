/**
 * A reply's tool setting is read from the thread's own connection, and only
 * when thread and connection both belong to the owner the reply runs as.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { getReplyToolSetting } from "./functions";

const OWNER = "owner";

let harness: ReturnType<typeof lunoraTest>;

const setup = async (options: { connectionOwner?: string; replyTools?: { enabled: boolean; groups?: string[] }; threadOwner?: string }) =>
    await harness.run(async (ctx: any) => {
        const connectionId = await ctx.db.insert("messengerConnections", {
            connectedAt: 0,
            platform: "telegram",
            status: "active",
            userId: options.connectionOwner ?? OWNER,
            ...(options.replyTools && { replyTools: options.replyTools }),
        });
        const threadId = await ctx.db.insert("threads", {
            messengerConnectionId: connectionId,
            source: "telegram",
            status: "active",
            title: "Telegram Chat",
            userId: options.threadOwner ?? OWNER,
        });

        return threadId;
    });

const read = async (threadId: string, userId = OWNER) => await harness.run(async (ctx: any) => await ctx.runQuery(getReplyToolSetting, { threadId, userId }));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("getReplyToolSetting", () => {
    it("returns the connection's setting for its owner", async () => {
        const threadId = await setup({ replyTools: { enabled: true, groups: ["webSearch"] } });

        expect(await read(threadId)).toStrictEqual({ enabled: true, groups: ["webSearch"] });
    });

    it("is null when the connection never enabled tools", async () => {
        expect(await read(await setup({}))).toBeNull();
    });

    it("is null when the thread or the connection belongs to someone else", async () => {
        const replyTools = { enabled: true };

        expect(await read(await setup({ connectionOwner: "other", replyTools }))).toBeNull();
        expect(await read(await setup({ replyTools, threadOwner: "other" }))).toBeNull();
        expect(await read(await setup({ replyTools }), "other")).toBeNull();
    });
});
