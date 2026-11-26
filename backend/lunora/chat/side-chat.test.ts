/**
 * A side chat forks its parent's settled history into a new thread linked as "side", keeps the parent's permission mode,
 * and writes nothing to the parent. A parent of someone else, a locked, deleted, archived, temporary, public, host-run,
 * group, non-text, model-less, empty or custom-endpoint parent is refused, and a refusal writes nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { v } from "lunorash/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registeredApi, registerModule } from "../../test/registered-api";

import { internalAction, internalMutation } from "../_generated/server";
import { addMessagesHandler, cloneMessageBatch } from "../agent/messages";
import { lastSettledMessageId } from "../agent/branches";
import { insertContextResetRow, insertThread } from "../agent/table-writes";
import schema from "../schema";
import { getFullThreadForExport } from "./functions";
import { getLowRiskApprovalContext } from "./tool-permissions";
import { agentSwitchRowContent } from "../agent/agent-switch-logic";
import { threadHandoffTaint } from "../agent/thread-summary-taint";
import { computeTaint } from "../devices/lib/taint";
import { createSideChat, sideChatRefusalOf } from "./side-chat";

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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const { registry } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>() };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const OWNER = "user-a";
const OTHER = "user-b";

let harness: ReturnType<typeof lunoraTest>;

// The action reads other modules through `internal.*`: each one it reaches is registered by its path, as the guide tests do.
beforeAll(async () => {
    registerModule(registry, "agent_agent_switch", await import("../agent/agent-switch"));
    registerModule(registry, "bots_functions", await import("../bots/functions"));
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_context_reset", await import("./context-reset"));
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "chat_side_chat", await import("./side-chat"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
    registerModule(registry, "chat_thread_state", await import("./thread-state"));
});

afterAll(() => {
    vi.restoreAllMocks();
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

/** A parent thread of `userId` with `fields` applied on top of a plain text chat. */
const parentWith = async (userId: string, fields: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(async (ctx: any) =>
        String(
            await insertThread(ctx.db, {
                createdBy: userId,
                mode: "text",
                model: "openai/gpt-5",
                permissionMode: "auto",
                status: "active",
                tags: ["chat"],
                title: "plan the launch",
                updatedAt: 1,
                userId,
                ...fields,
            }),
        ),
    );

/** Adds `texts` as settled user messages to `threadId`, in order. */
const withMessages = async (threadId: string, userId: string, texts: string[]): Promise<void> => {
    await harness.run(async (ctx: any) => {
        await addMessagesHandler(ctx, {
            fromUser: true,
            messages: texts.map((content) => {
                return { message: { content, role: "user" }, status: "success" };
            }),
            threadId: threadId as never,
            userId,
        });
    });
};

const threadRow = async (threadId: string): Promise<any> => await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

const messageCount = async (threadId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db
            .query("messages")
            .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
            .collect();

        return rows.length;
    });

const sideRelations = async (): Promise<any[]> =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("threadRelationships").collect();

        return rows.filter((row: any) => row.branchType === "side");
    });

describe("sideChatRefusalOf", () => {
    it("refuses each parent it must not start beside, and allows a plain text chat", () => {
        expect(sideChatRefusalOf(null, true)).toBe("not_found");
        expect(sideChatRefusalOf({}, false)).toBe("not_found");
        expect(sideChatRefusalOf({ deleted: true }, true)).toBe("deleted");
        expect(sideChatRefusalOf({ lockedAt: 1 }, true)).toBe("locked");
        expect(sideChatRefusalOf({ status: "archived" }, true)).toBe("archived");
        // Reopened: the status is back to active, and `archivedAt` keeps the time of the last archive.
        expect(sideChatRefusalOf({ archivedAt: 1, model: "openai/gpt-5", status: "active" }, true)).toBeNull();
        expect(sideChatRefusalOf({ runner: "host" }, true)).toBe("host_run");
        expect(sideChatRefusalOf({ groupChat: {} }, true)).toBe("group_or_shared");
        expect(sideChatRefusalOf({ multiChat: true }, true)).toBe("group_or_shared");
        expect(sideChatRefusalOf({ mode: "image" }, true)).toBe("not_text");
        expect(sideChatRefusalOf({ model: "openai/gpt-5" }, true)).toBeNull();
        expect(sideChatRefusalOf({}, true)).toBe("no_model");
        expect(sideChatRefusalOf({ model: "custom:acme/model" }, true)).toBe("custom_endpoint");
        expect(sideChatRefusalOf({ activeAgent: { kind: "model", model: "custom:acme/model" }, model: "openai/gpt-5" }, true)).toBe("custom_endpoint");
        expect(sideChatRefusalOf({ activeAgent: { kind: "model", model: "openai/gpt-5" }, model: "openai/gpt-5" }, true)).toBeNull();
        expect(sideChatRefusalOf({ isTemporary: true, model: "openai/gpt-5" }, true)).toBe("shared_or_temporary");
        expect(sideChatRefusalOf({ deletingAt: 1, model: "openai/gpt-5" }, true)).toBe("shared_or_temporary");
        expect(sideChatRefusalOf({ isPublic: true, model: "openai/gpt-5" }, true)).toBe("shared_or_temporary");
        expect(sideChatRefusalOf({ model: "openai/gpt-5", publicAccessToken: "tok" }, true)).toBe("shared_or_temporary");
    });
});

describe("createSideChat", () => {
    it("forks the parent's settled history into a new thread linked as side, keeps its mode, and leaves the parent as it was", async () => {
        const parentId = await parentWith(OWNER, { permissionMode: "supervised" });

        await withMessages(parentId, OWNER, ["first question", "second question"]);
        const before = await threadRow(parentId);
        const parentMessages = await messageCount(parentId);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(outcome.status).toBe("ok");

        const child = await threadRow(outcome.threadId);

        expect(child).toMatchObject({ permissionMode: "supervised", status: "active", userId: OWNER });
        expect(await messageCount(outcome.threadId)).toBe(2);

        const [link] = await sideRelations();

        expect(link).toMatchObject({ branchType: "side", parentThreadId: parentId, threadId: outcome.threadId, userId: OWNER });
        expect(await messageCount(parentId)).toBe(parentMessages);
        expect(await threadRow(parentId)).toStrictEqual(before);
    });

    it("refuses an empty parent, and writes nothing", async () => {
        const parentId = await parentWith(OWNER);

        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({ reason: "empty", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
    });

    it("refuses a parent of someone else, and writes nothing", async () => {
        const parentId = await parentWith(OTHER);

        await withMessages(parentId, OTHER, ["hello"]);

        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({ reason: "not_found", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
    });

    it("refuses a locked parent and a host-run parent, and writes nothing", async () => {
        const lockedId = await parentWith(OWNER, { lockedAt: 5 });
        const hostId = await parentWith(OWNER, { runner: "host" });

        await withMessages(lockedId, OWNER, ["hello"]);
        await withMessages(hostId, OWNER, ["hello"]);

        expect(await as(OWNER).action(createSideChat as never, { threadId: lockedId } as never)).toStrictEqual({ reason: "locked", status: "refused" });
        expect(await as(OWNER).action(createSideChat as never, { threadId: hostId } as never)).toStrictEqual({ reason: "host_run", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
    });

    it("starts a side chat from a parent with no permission mode, without an explicit undefined mode", async () => {
        const parentId = await parentWith(OWNER, { permissionMode: undefined });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(outcome.status).toBe("ok");
        expect(child.permissionMode).toBeUndefined();
    });

    it("keeps the parent's organization and cap organization on the child", async () => {
        const parentId = await parentWith(OWNER, { capOrganizationId: "org-cap", organizationId: "org-1" });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(child).toMatchObject({ capOrganizationId: "org-cap", organizationId: "org-1" });
    });

    it("copies up to the last settled reply, never a reply still in flight or one that failed", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["settled"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    { message: { content: "streaming", role: "assistant" }, status: "pending" },
                    { message: { content: "broken", role: "assistant" }, status: "failed" },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(outcome.status).toBe("ok");
        expect(await messageCount(outcome.threadId)).toBe(1);
    });

    it("refuses a parent whose only rows are unsettled, and writes nothing", async () => {
        const parentId = await parentWith(OWNER);

        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [{ message: { content: "streaming", role: "assistant" }, status: "pending" }],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({ reason: "empty", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
    });

    it("honours a context reset of the parent in the child", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["before the clear"]);
        await harness.run(async (ctx: any) => {
            await insertContextResetRow(ctx.db, { order: 5, threadId: parentId as never, userId: OWNER });
            await ctx.db.patch("threads", parentId, { hasContextReset: true });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(outcome.status).toBe("ok");
        expect(child.hasContextReset).toBe(true);
        expect(child.contextResetMessageId).toBeDefined();
    });

    it("leaves no side relationship when the copy fails", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const key = "agent_messages:cloneThread";
        const original = registry.get(key);

        registry.set(
            key,
            internalAction.input({ sourceThreadId: v.id("threads"), targetThreadId: v.id("threads") }).action(async () => {
                throw new Error("copy failed");
            }),
        );

        try {
            await expect(as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).rejects.toThrow("copy failed");
        } finally {
            registry.set(key, original);
        }

        expect(await sideRelations()).toHaveLength(0);
    });

    it("records the child's creation as a side chat of the parent", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("documentHistory").collect());

        expect(rows.some((row: any) => String(row.documentId) === outcome.threadId)).toBe(true);
    });

    it("ends before a reply that is still mid tool call, at the last finished message", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["first question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [{ message: { content: [{ text: "settled answer", type: "text" }], role: "assistant" }, status: "success" }],
                threadId: parentId as never,
                userId: OWNER,
            });
        });
        await withMessages(parentId, OWNER, ["second question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "c1", toolName: "search", type: "tool-call" }], role: "assistant" },
                        status: "success",
                    },
                    {
                        message: {
                            content: [{ output: { type: "text", value: "hits" }, toolCallId: "c1", toolName: "search", type: "tool-result" }],
                            role: "tool",
                        },
                        status: "success",
                    },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const parentRows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const secondQuestion = parentRows.find((row: any) => JSON.stringify(row.message).includes("second question"));
        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(outcome.status).toBe("ok");
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(lastSettledMessageId, { threadId: parentId }))).toBe(secondQuestion._id);

        const allRows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const childRows = allRows.filter((row: any) => String(row.threadId) === outcome.threadId);
        const copied = JSON.stringify(childRows.map((row: any) => row.message));

        expect(childRows).toHaveLength(3);
        expect(copied).toContain("settled answer");
        expect(copied).not.toContain("tool-");
    });

    it("ends at the last finished reply when a later reply in the same turn is a tool result", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "c1", toolName: "search", type: "tool-call" }], role: "assistant" },
                        status: "success",
                    },
                    {
                        message: {
                            content: [{ output: { type: "text", value: "hits" }, toolCallId: "c1", toolName: "search", type: "tool-result" }],
                            role: "tool",
                        },
                        status: "success",
                    },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const parentRows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const question = parentRows.find((row: any) => JSON.stringify(row.message).includes("question"));

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(lastSettledMessageId, { threadId: parentId }))).toBe(question._id);
    });

    it("gives the child the parent's run settings", async () => {
        const parentId = await parentWith(OWNER, { autoModel: true, customSystemPrompt: "answer in haiku", reasoningEffort: 3, statelessMode: true });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(await threadRow(outcome.threadId)).toMatchObject({
            autoModel: true,
            customSystemPrompt: "answer in haiku",
            model: "openai/gpt-5",
            reasoningEffort: 3,
            statelessMode: true,
        });
    });

    it("leaves no child and no side relationship when recording the history fails", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const key = "lib_document_history:recordHistory";
        const original = registry.get(key);

        registry.set(
            key,
            internalMutation.input({}).mutation(async () => {
                throw new Error("history failed");
            }),
        );

        try {
            await expect(as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).rejects.toThrow("history failed");
        } finally {
            registry.set(key, original);
        }

        expect(await sideRelations()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(1);
    });

    it("exports a side chat with each settled turn once, and none of the parent's unsettled rows", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["first question", "second question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [{ message: { content: "still streaming", role: "assistant" }, status: "pending" }],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const exported = (await as(OWNER).query(getFullThreadForExport as never, { model: "openai/gpt-5", threadId: outcome.threadId } as never)) as {
            messages: { message: { content: unknown } }[];
        };
        const texts = exported.messages.map((row) => JSON.stringify(row.message.content));

        expect(texts).toHaveLength(2);
        expect(texts.filter((text) => text.includes("first question"))).toHaveLength(1);
        expect(texts.filter((text) => text.includes("second question"))).toHaveLength(1);
        expect(texts.some((text) => text.includes("still streaming"))).toBe(false);
    });

    it("ends before an earlier reply that stopped mid tool call, even when a later user message succeeded", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["first question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [{ message: { content: [{ text: "complete answer", type: "text" }], role: "assistant" }, status: "success" }],
                threadId: parentId as never,
                userId: OWNER,
            });
        });
        await withMessages(parentId, OWNER, ["second question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "lost", toolName: "search", type: "tool-call" }], role: "assistant" },
                        status: "success",
                    },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });
        await withMessages(parentId, OWNER, ["later question"]);

        const parentRows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const secondQuestion = parentRows.find((row: any) => JSON.stringify(row.message).includes("second question"));
        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(outcome.status).toBe("ok");
        expect(await harness.run(async (ctx: any) => await ctx.runQuery(lastSettledMessageId, { threadId: parentId }))).toBe(secondQuestion._id);

        const allRows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());
        const copied = allRows.filter((row: any) => String(row.threadId) === outcome.threadId).map((row: any) => JSON.stringify(row.message));

        expect(copied).toHaveLength(3);
        expect(copied.some((text: string) => text.includes("complete answer"))).toBe(true);
        expect(copied.some((text: string) => text.includes("tool-call") || text.includes("later question"))).toBe(false);
    });

    it("copies only the prompt when the first reply stopped mid tool call", async () => {
        const parentId = await parentWith(OWNER);

        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: { content: "question", role: "user" }, status: "success" }],
                threadId: parentId as never,
                userId: OWNER,
            });
            await addMessagesHandler(ctx, {
                messages: [
                    { message: { content: [{ input: {}, toolCallId: "lost", toolName: "search", type: "tool-call" }], role: "assistant" }, status: "success" },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });
        await withMessages(parentId, OWNER, ["follow up"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };

        expect(outcome.status).toBe("ok");
        expect(await messageCount(outcome.threadId)).toBe(1);
    });

    it("gives the child the device-call taint of the parent: the takeover and the tool results it copied", async () => {
        const parentId = await parentWith(OWNER, { hasHandoff: true });
        const host = { agentKey: "agent", agentLabel: "Agent", folderId: "folder", folderLabel: "Folder", hostId: "host-1", kind: "host" as const };

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("messages", {
                ...agentSwitchRowContent({ from: host, mode: "portable", startMessageId: "none", to: { kind: "model", model: "openai/gpt-5" } }),
                order: 0,
                status: "success",
                stepOrder: 0,
                threadId: parentId,
                tool: false,
                userId: OWNER,
            });
        });
        await withMessages(parentId, OWNER, ["look it up"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "w1", toolName: "webSearch", type: "tool-call" }], role: "assistant" },
                        status: "success",
                    },
                    {
                        message: {
                            content: [{ output: { type: "text", value: "page text" }, toolCallId: "w1", toolName: "webSearch", type: "tool-result" }],
                            role: "tool",
                        },
                        status: "success",
                    },
                    { message: { content: [{ text: "here is the answer", type: "text" }], role: "assistant" }, status: "success" },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const rowsOf = async (threadId: string) => {
            const all = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

            return all.filter((row: any) => String(row.threadId) === threadId).map((row: any) => row.message);
        };

        expect(outcome.status).toBe("ok");
        expect(await harness.run(async (ctx: any) => await threadHandoffTaint(ctx, parentId as never))).toStrictEqual(["web", "device"]);
        expect(await harness.run(async (ctx: any) => await threadHandoffTaint(ctx, outcome.threadId as never))).toStrictEqual(["web", "device"]);
        expect(computeTaint(await rowsOf(outcome.threadId))).toStrictEqual(computeTaint(await rowsOf(parentId)));
        expect(computeTaint(await rowsOf(outcome.threadId))).toContain("web");
    });

    it("refuses a parent that no longer exists, and writes no child or relationship", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const targetId = await parentWith(OWNER, { title: "copy" });

        await harness.run(async (ctx: any) => {
            await ctx.db.delete("threads", parentId);
        });

        await expect(
            harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(cloneMessageBatch, {
                        paginationOpts: { cursor: null, numItems: 100 },
                        sourceThreadId: parentId,
                        targetThreadId: targetId,
                    }),
            ),
        ).rejects.toThrow();
        expect(await messageCount(targetId)).toBe(0);
        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({ reason: "not_found", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(1);
    });

    it("gives the side chat the parent's run settings", async () => {
        const parentId = await parentWith(OWNER, { customSystemPrompt: "Answer briefly.", reasoningEffort: 2, statelessMode: true });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(child).toMatchObject({ customSystemPrompt: "Answer briefly.", reasoningEffort: 2, statelessMode: true });
    });

    it("refuses a parent that someone else holds a grant on, and writes nothing", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: parentId, userId: "user-c" });
        });

        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({
            reason: "shared_or_temporary",
            status: "refused",
        });
        expect(await sideRelations()).toHaveLength(0);
    });

    it("keeps a completed tool turn whose result is stored in a later message than its call", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["question"]);
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: { content: [{ input: {}, toolCallId: "c1", toolName: "search", type: "tool-call" }], role: "assistant" },
                        status: "success",
                    },
                ],
                threadId: parentId as never,
                userId: OWNER,
            });
        });
        // The approved call resumes later: its result is stored after the call, in a message of its own, then the reply finishes.
        await harness.run(async (ctx: any) => {
            await addMessagesHandler(ctx, {
                messages: [
                    {
                        message: {
                            content: [{ output: { type: "text", value: "hits" }, toolCallId: "c1", toolName: "search", type: "tool-result" }],
                            role: "tool",
                        },
                        status: "success",
                    },
                ],
                overrideOrder: 10,
                threadId: parentId as never,
                userId: OWNER,
            });
            await addMessagesHandler(ctx, {
                messages: [{ message: { content: [{ text: "done", type: "text" }], role: "assistant" }, status: "success" }],
                threadId: parentId as never,
                userId: OWNER,
            });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const childRows = await harness.run(async (ctx: any) => {
            const rows = await ctx.db.query("messages").collect();

            return rows.filter((row: any) => String(row.threadId) === outcome.threadId);
        });
        const copied = JSON.stringify(childRows.map((row: any) => row.message));

        expect(outcome.status).toBe("ok");
        expect(childRows).toHaveLength(4);
        expect(copied).toContain("hits");
        expect(copied).toContain("done");
    });

    it("forks a parent whose only grant has expired, since nobody else can read it through that grant", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadAccess", { expiresAt: 1, grantedAt: 0, grantedBy: OWNER, permission: "read", threadId: parentId, userId: "user-c" });
        });

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string };

        expect(outcome.status).toBe("ok");
    });

    it("keeps the import and handoff markers on the side chat, so its tools are not auto-approved on handed-over history", async () => {
        const parentId = await parentWith(OWNER, { createdBy: "import:chat-export", hasHandoff: true });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(outcome.status).toBe("ok");
        expect(child).toMatchObject({ createdBy: "import:chat-export", hasHandoff: true });
    });

    it("carries an imported parent's marker to the child, which keeps low-risk auto-approval off", async () => {
        const importedId = await parentWith(OWNER, { createdBy: "import:chatgpt" });
        const plainId = await parentWith(OWNER);

        await withMessages(importedId, OWNER, ["hello"]);
        await withMessages(plainId, OWNER, ["hello"]);
        await harness.run(async (ctx: any) => await ctx.db.insert("aiUserPreferences", { autoApproveLowRisk: true, userId: OWNER }));

        const imported = (await as(OWNER).action(createSideChat as never, { threadId: importedId } as never)) as { threadId: string };
        const plain = (await as(OWNER).action(createSideChat as never, { threadId: plainId } as never)) as { threadId: string };
        const allowed = async (threadId: string): Promise<boolean> =>
            await harness.run(async (ctx: any) => await ctx.runQuery(getLowRiskApprovalContext, { threadId, userId: OWNER }));

        const importedChild = await threadRow(imported.threadId);

        expect(importedChild.createdBy).toBe("import:chatgpt");
        expect(await allowed(imported.threadId)).toBe(false);
        expect(await allowed(plain.threadId)).toBe(true);
    });

    it("refuses a parent whose bot now runs on a custom endpoint, and writes nothing", async () => {
        const botId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("bots", {
                    computerEnabled: false,
                    createdAt: 1,
                    instructions: "",
                    model: "custom:acme/model",
                    name: "bot",
                    updatedAt: 1,
                    userId: OWNER,
                }),
        );
        const parentId = await parentWith(OWNER, { botId: String(botId) });

        await withMessages(parentId, OWNER, ["hello"]);

        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({
            reason: "custom_endpoint",
            status: "refused",
        });
        expect(await sideRelations()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(1);
    });

    it("leaves no readable child when the copy fails after more than one page was written", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const parentMessages = await messageCount(parentId);
        const key = "agent_messages:cloneThread";
        const original = registry.get(key);

        registry.set(
            key,
            internalAction.input({ sourceThreadId: v.id("threads"), targetThreadId: v.id("threads") }).action(async ({ args }) => {
                await harness.run(async (ctx: any) => {
                    for (let order = 0; order < 230; order += 1) {
                        await ctx.db.insert("messages", {
                            message: { content: `row ${order}`, role: "user" },
                            order,
                            status: "success",
                            stepOrder: 0,
                            threadId: args.targetThreadId,
                            tool: false,
                            userId: OWNER,
                        });
                    }
                });

                throw new Error("copy failed late");
            }),
        );

        try {
            await expect(as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).rejects.toThrow("copy failed late");
        } finally {
            registry.set(key, original);
        }

        const threads = await harness.run(async (ctx: any) => await ctx.db.query("threads").collect());
        const rows = await harness.run(async (ctx: any) => await ctx.db.query("messages").collect());

        expect(threads).toHaveLength(1);
        expect(rows).toHaveLength(parentMessages);
        expect(await sideRelations()).toHaveLength(0);
    });

    it("refuses a parent trashed before the copy, and leaves no child or side link", async () => {
        const parentId = await parentWith(OWNER);

        await withMessages(parentId, OWNER, ["hello"]);

        const targetId = await parentWith(OWNER, { title: "copy" });

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", parentId, { deleted: true }));

        await expect(
            harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(cloneMessageBatch, {
                        paginationOpts: { cursor: null, numItems: 100 },
                        refuseTrashedSource: true,
                        sourceThreadId: parentId,
                        targetThreadId: targetId,
                    }),
            ),
        ).rejects.toThrow();
        expect(await messageCount(targetId)).toBe(0);

        // Without the option the copy is unchanged for every other caller.
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(cloneMessageBatch, {
                    paginationOpts: { cursor: null, numItems: 100 },
                    sourceThreadId: parentId,
                    targetThreadId: targetId,
                }),
        );
        expect(await messageCount(targetId)).toBe(1);
        expect(await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)).toStrictEqual({ reason: "deleted", status: "refused" });
        expect(await sideRelations()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.query("threads").collect())).toHaveLength(2);
    });

    it("gives the side chat the parent's worker-dispatch policy, so its worker requests keep the same cap", async () => {
        const parentId = await parentWith(OWNER, { workerPolicy: { allowedSources: [], hostDispatch: "ask", maxDispatchesPerHour: 5 } });

        await withMessages(parentId, OWNER, ["hello"]);

        const outcome = (await as(OWNER).action(createSideChat as never, { threadId: parentId } as never)) as { status: string; threadId: string };
        const child = await threadRow(outcome.threadId);

        expect(outcome.status).toBe("ok");
        expect(child.workerPolicy).toMatchObject({ allowedSources: [], hostDispatch: "ask", maxDispatchesPerHour: 5 });
    });
});
