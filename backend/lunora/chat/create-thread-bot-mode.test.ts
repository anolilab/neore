/**
 * A chat started with a bot takes the bot's own permission mode when it has one. A bot with none starts in the owner's default,
 * as any new chat does. An admin acting as the owner never takes `full` from the bot or from the default.
 */
import { lunoraTest } from "@lunora/testing";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { createBot } from "../bots/functions";
import { createThread } from "./functions";

const OWNER = "user-owner";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const state = vi.hoisted(() => {
    return { by: undefined as string | undefined };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/audit-triggers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/audit-triggers")>()),
        auditTriggersFor: () => {
            return {};
        },
    };
});

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

// The agent's own reads are not what this tests: a stand-in inserts the thread as the agent's `createThread` does.
vi.mock("./lib/thread-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./lib/thread-helpers")>()),
        getAgentForUser: async () => {
            return {
                createThread: async (ctx: any, fields: Record<string, unknown>) => {
                    return { threadId: await ctx.db.insert("threads", { status: "active", ...fields }) };
                },
            };
        },
    };
});

let harness: ReturnType<typeof lunoraTest>;

const owner = () => harness.withIdentity({ userId: OWNER });

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "chat_thread_state", await import("./thread-state"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "bots_functions", await import("../bots/functions"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
}, 60_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    state.by = undefined;
    harness.close();
});

/** Sets the owner's default for new chats (one settings row per user). */
const setDefault = async (defaultPermissionMode: "auto" | "full" | "supervised" | undefined): Promise<void> =>
    await harness.run(async (ctx: any) => {
        await ctx.db.insert("userSettings", { defaultPermissionMode, userId: OWNER });
    });

/** Creates a bot with `permissionMode` (absent = the bot's own default) and returns its id. */
const makeBot = async (permissionMode?: "auto" | "full" | "supervised"): Promise<string> =>
    (await owner().mutation(
        createBot as never,
        { computerEnabled: false, instructions: "Be brief.", model: DEFAULT_CHAT_MODEL, name: "Helper", permissionMode } as never,
    )) as string;

/** Starts a chat, optionally with a bot, and reads back the thread row it created. */
const start = async (botId?: string): Promise<Record<string, unknown>> => {
    const threadId = (await owner().mutation(createThread as never, { model: DEFAULT_CHAT_MODEL, ...(botId && { botId }) } as never)) as string;

    return await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));
};

describe("a chat started with a bot takes the bot's mode, or the owner's default when the bot has none", () => {
    it("takes the bot's own mode over the owner's default", async () => {
        await setDefault("full");

        const botId = await makeBot("supervised");

        expect(await start(botId)).toMatchObject({ permissionMode: "supervised" });
    });

    it("starts in the owner's default when the bot has no mode of its own", async () => {
        await setDefault("supervised");

        const botId = await makeBot();

        expect(await start(botId)).toMatchObject({ permissionMode: "supervised" });
    });

    it("stores no mode when the bot has none and the owner has no default", async () => {
        const botId = await makeBot();

        expect(await start(botId)).not.toHaveProperty("permissionMode");
    });

    it("does not take a bot's full mode while impersonating, and falls back to the owner's default", async () => {
        await setDefault("supervised");

        const botId = await makeBot("full");

        state.by = "admin-1";

        expect(await start(botId)).toMatchObject({ permissionMode: "supervised" });
    });

    it("never gives an admin acting as the owner full through a bot with no mode", async () => {
        await setDefault("full");

        const botId = await makeBot();

        state.by = "admin-1";

        expect(await start(botId)).not.toHaveProperty("permissionMode");
    });
});
