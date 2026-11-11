/**
 * The approval push: the phone's alert names the tool and the teammate, carries the approval's id for approve and deny,
 * and is sent only while the approval is still pending on its chat.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { phoneMessage, TOOL_APPROVAL_CATEGORY } from "./phone-delivery";
import { approvalPushNames } from "./phone-content";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "u1";
const APPROVAL_ID = "approval-1";
const DEVICE = { language: "en", platform: "ios" as const, token: "ExponentPushToken[abc]" };

const CONFIG = {
    autoMediaEnrichment: false,
    mcpServerNames: [],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: [],
};

const requestMessage = (approvalId: string, toolName: string) => {
    return {
        content: [
            { input: { secret: "do not show" }, toolCallId: `call-${approvalId}`, toolName, type: "tool-call" },
            { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
        ],
        role: "assistant",
    };
};

let harness: Harness;
let threadId = "";

const insertMessage = async (order: number, message: unknown, tool = false) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder: 0, threadId, tool, userId: OWNER }));

const names = async (args: { approvalId?: string; userId?: string } = {}) =>
    await harness.run(async (ctx: any) => await approvalPushNames(ctx, { approvalId: args.approvalId ?? APPROVAL_ID, threadId, userId: args.userId ?? OWNER }));

/** A thread with a teammate: a bot named Ada. */
const seedThread = async () => {
    const botId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 1,
                instructions: "",
                model: "test-model",
                name: "Ada",
                updatedAt: 1,
                userId: OWNER,
            }),
    );

    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { botId, title: "Inbox", userId: OWNER }))) as string;
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    await seedThread();
    await insertMessage(0, { content: "delete my file", role: "user" });
    await insertMessage(1, requestMessage(APPROVAL_ID, "deleteFile"), true);
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: APPROVAL_ID,
                config: CONFIG,
                createdAt: Date.now(),
                status: "pending",
                threadId,
                userId: OWNER,
            }),
    );
});

afterEach(() => {
    harness.close();
});

describe("the approval alert on a phone", () => {
    const message = (approval: { approvalId: string; teammate: string; tool: string | null } | undefined) =>
        phoneMessage(DEVICE, {
            notificationId: "n1",
            threadId: "t1",
            urgency: "high",
            ...(approval && { approval }),
        });

    it("names the tool as the title and the teammate as the body", () => {
        const sent = message({ approvalId: APPROVAL_ID, teammate: "Ada", tool: "deleteFile" });

        expect(sent.title).toBe("deleteFile");
        expect(sent.body).toBe("Ada");
        expect(sent.categoryId).toBe(TOOL_APPROVAL_CATEGORY);
    });

    it("carries only ids in data, never the call's arguments, for the names the seeded request loads", async () => {
        // The message is built from what the loader reads off the seeded request, whose arguments hold the secret.
        const loaded = await names();
        const sent = message(loaded ?? undefined);

        expect(sent.title).toBe("deleteFile");
        expect(sent.body).toBe("Ada");

        expect(sent.data).toStrictEqual({ approvalId: APPROVAL_ID, notificationId: "n1", threadId: "t1" });
        expect(JSON.stringify(sent)).not.toContain("do not show");
    });

    it("leaves a plain notification as it was, with no action set", () => {
        const sent = message(undefined);

        expect(sent.categoryId).toBeUndefined();
        expect(sent.data).toStrictEqual({ notificationId: "n1", threadId: "t1" });
    });

    it("cuts a tool name longer than the lock screen shows", () => {
        expect(message({ approvalId: APPROVAL_ID, teammate: "Ada", tool: "x".repeat(300) }).title).toHaveLength(100);
    });

    it("titles a call whose name cannot be read back in the phone's own language", () => {
        const german = phoneMessage(
            { ...DEVICE, language: "de-DE" },
            {
                approval: { approvalId: APPROVAL_ID, teammate: "Ada", tool: null },
                notificationId: "n1",
                threadId: "t1",
                urgency: "high",
            },
        );

        expect(german.title).toBe("Ein Werkzeug");
        expect(message({ approvalId: APPROVAL_ID, teammate: "Ada", tool: null }).title).toBe("A tool");
    });
});

describe("the names an approval push is built from", () => {
    it("names the tool that is pending and the chat's teammate", async () => {
        expect(await names()).toStrictEqual({ approvalId: APPROVAL_ID, teammate: "Ada", tool: "deleteFile" });
    });

    it("names another request of the same pause once the one asked is answered, so the push's controls still reach a live request", async () => {
        await harness.run(async (ctx: any) => {
            const [run] = await ctx.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", APPROVAL_ID))
                .take(1);

            await ctx.db.patch("toolApprovalRuns", run._id, { pauseId: APPROVAL_ID, status: "approved" });
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: "a2",
                config: CONFIG,
                createdAt: Date.now(),
                pauseId: APPROVAL_ID,
                status: "pending",
                threadId,
                userId: OWNER,
            });
        });
        await insertMessage(2, requestMessage("a2", "webSearch"), true);

        expect(await names()).toStrictEqual({ approvalId: "a2", teammate: "Ada", tool: "webSearch" });
    });

    it("refuses an approval the conversation has moved past", async () => {
        await insertMessage(2, { content: "never mind", role: "user" });

        expect(await names()).toBeNull();
    });

    it("refuses an approval of another user", async () => {
        expect(await names({ userId: "u2" })).toBeNull();
    });

    it("refuses an approval id that is not on this chat", async () => {
        expect(await names({ approvalId: "approval-missing" })).toBeNull();
    });

    it("refuses a locked chat", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: Date.now() }));

        expect(await names()).toBeNull();
    });

    it("refuses a question, which is answered with text", async () => {
        await insertMessage(2, requestMessage("question-1", "askUser"), true);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "question-1",
                    config: CONFIG,
                    createdAt: Date.now(),
                    status: "pending",
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await names({ approvalId: "question-1" })).toBeNull();
    });

    it("refuses a secret request, which is answered with a value and never with approve or deny", async () => {
        await insertMessage(2, requestMessage("secret-1", "requestSecret"), true);
        await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "secret-1",
                    config: CONFIG,
                    createdAt: Date.now(),
                    secretRequest: true,
                    status: "pending",
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await names({ approvalId: "secret-1" })).toBeNull();
    });

    it("refuses an approval whose row is no longer pending, though its request still sits in the chat", async () => {
        await harness.run(async (ctx: any) => {
            const [run] = await ctx.db
                .query("toolApprovalRuns")
                .withIndex("by_approvalId", (q: any) => q.eq("approvalId", APPROVAL_ID))
                .take(1);

            await ctx.db.patch("toolApprovalRuns", run._id, { status: "approved" });
        });

        expect(await names()).toBeNull();
    });

    it("refuses an archived chat, as the in-app text path does", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { status: "archived" }));

        expect(await names()).toBeNull();
    });
});
