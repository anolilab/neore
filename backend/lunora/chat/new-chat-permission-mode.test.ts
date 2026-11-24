/**
 * A new chat starts in the owner's default permission mode (`userSettings.defaultPermissionMode`). The default is read when a chat
 * is created and never afterwards: a thread that already holds a stored mode keeps it when the default changes.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { newChatPermissionMode } from "./lib/thread-permission-mode";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

// The agent's own reads (model, preferences) are not what this tests: a stand-in inserts the thread as the agent's
// `createThread` does, with the fields it is given, and saves the first message.
vi.mock("./lib/thread-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/thread-helpers")>()),
        getAgentForUser: async () => {
            return {
                createThread: async (ctx: any, fields: Record<string, unknown>) => {
                    return { threadId: await ctx.db.insert("threads", { status: "active", ...fields }) };
                },
                saveMessage: async () => {
                    return { messageId: "message-1" };
                },
            };
        },
    };
});

const OWNER = "owner";

const { default: schema } = await import("../schema");
const threads = await import("../agent/threads");
const { createThreadWithInitialMessage } = await import("./functions");

let harness: ReturnType<typeof lunoraTest>;

/** Starts a chat as the owner and reads back the thread row it created. */
const start = async (fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    await harness.run(async (ctx: any) => {
        const { threadId } = await ctx.runMutation(createThreadWithInitialMessage, {
            messageContent: [{ text: "hi", type: "text" }],
            model: "openai/gpt-4.1-mini",
            userId: OWNER,
            ...fields,
        });

        return await ctx.db.get("threads", threadId);
    });

/** Sets the owner's default for new chats, as `updateUserSettings` does (one settings row per user). */
const setDefault = async (defaultPermissionMode: "auto" | "full" | "supervised" | undefined): Promise<void> =>
    await harness.run(async (ctx: any) => {
        const existing = await ctx.db
            .query("userSettings")
            .withIndex("by_userId", (q: any) => q.eq("userId", OWNER))
            .unique();

        if (existing) {
            await ctx.db.patch("userSettings", existing._id, { defaultPermissionMode });

            return;
        }

        await ctx.db.insert("userSettings", { defaultPermissionMode, userId: OWNER });
    });

beforeAll(() => {
    registerModule(registry, "agent_threads", threads);
}, 60_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("newChatPermissionMode", () => {
    it("stores nothing for an absent default or auto, which are the defaults", () => {
        expect(newChatPermissionMode(undefined, false)).toBeUndefined();
        expect(newChatPermissionMode("auto", false)).toBeUndefined();
    });

    it("gives a new chat the default it names", () => {
        expect(newChatPermissionMode("supervised", false)).toBe("supervised");
        expect(newChatPermissionMode("full", false)).toBe("full");
    });

    it("never gives an impersonating admin full, but still gives supervised", () => {
        expect(newChatPermissionMode("full", true)).toBeUndefined();
        expect(newChatPermissionMode("supervised", true)).toBe("supervised");
    });
});

describe("createThreadWithInitialMessage takes the owner's default mode", () => {
    it("starts a new chat in the default the owner set", async () => {
        await setDefault("supervised");

        const thread = await start();

        expect(thread).toMatchObject({ permissionMode: "supervised" });
    });

    it("stores no mode when the owner has no default, so the chat runs under the defaults as before", async () => {
        const thread = await start();

        expect(thread).not.toHaveProperty("permissionMode");
    });

    it("stores no mode when the default is auto, which is what an absent mode means", async () => {
        await setDefault("auto");

        const thread = await start();

        expect(thread).not.toHaveProperty("permissionMode");
    });

    it("does not give an impersonating admin's new chat the owner's full default", async () => {
        await setDefault("full");

        const thread = await start({ impersonated: true });

        expect(thread).not.toHaveProperty("permissionMode");
    });

    it("keeps an existing thread's stored mode when the default changes, and gives only new chats the new default", async () => {
        const existingId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("threads", {
                    permissionMode: "full",
                    status: "active",
                    title: "Existing",
                    updatedAt: 1,
                    userId: OWNER,
                }),
        );

        await setDefault("supervised");

        const first = await start();

        await setDefault("auto");

        const second = await start();

        const existing = await harness.run(async (ctx: any) => await ctx.db.get("threads", existingId));

        expect(existing).toMatchObject({ permissionMode: "full" });
        expect(first).toMatchObject({ permissionMode: "supervised" });
        expect(second).not.toHaveProperty("permissionMode");
    });
});
