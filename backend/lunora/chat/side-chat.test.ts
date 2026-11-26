/**
 * A side chat forks its parent's settled history into a new thread linked as "side", keeps the parent's permission mode,
 * and writes nothing to the parent. A parent of someone else, a locked, deleted, archived, temporary, public, host-run,
 * group, non-text, model-less, empty or custom-endpoint parent is refused, and a refusal writes nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registeredApi, registerModule } from "../../test/registered-api";

import { addMessagesHandler } from "../agent/messages";
import { insertThread } from "../agent/table-writes";
import schema from "../schema";
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
    registerModule(registry, "agent_branches", await import("../agent/branches"));
    registerModule(registry, "agent_messages", await import("../agent/messages"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "chat_functions", await import("./functions"));
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
        expect(sideChatRefusalOf({ archivedAt: 1 }, true)).toBe("archived");
        expect(sideChatRefusalOf({ runner: "host" }, true)).toBe("host_run");
        expect(sideChatRefusalOf({ groupChat: {} }, true)).toBe("group_or_shared");
        expect(sideChatRefusalOf({ multiChat: true }, true)).toBe("group_or_shared");
        expect(sideChatRefusalOf({ mode: "image" }, true)).toBe("not_text");
        expect(sideChatRefusalOf({ model: "openai/gpt-5" }, true)).toBeNull();
        expect(sideChatRefusalOf({}, true)).toBe("no_model");
        expect(sideChatRefusalOf({ model: "custom:acme/model" }, true)).toBe("custom_endpoint");
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
});
