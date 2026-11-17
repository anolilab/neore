/**
 * A bot's permission mode: a new chat with the bot starts in it, the chat's own mode can still be changed, an unattended run reads it
 * for the bot it names or the bot of the thread it continues, and an admin acting as the owner cannot set it.
 */
import { lunoraTest } from "@lunora/testing";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { createThread } from "../chat/functions";
import { setThreadPermissionMode } from "../chat/thread-state";
import { createBot, getBotPermissionModeForRun, updateBot } from "./functions";

const OWNER = "user-owner";
const STRANGER = "user-stranger";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { impersonation, sessionFrom } = vi.hoisted(() => {
    // Set while a test acts as an admin impersonating the signed-in user.
    const state = { by: undefined as string | undefined };

    return {
        impersonation: state,
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, impersonatedBy: state.by, userId: context.auth.userId } : null,
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

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("../chat/functions"));
    registerModule(registry, "chat_thread_state", await import("../chat/thread-state"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "bots_functions", await import("./functions"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    impersonation.by = undefined;
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

const botWith = async (permissionMode?: "auto" | "full" | "supervised") =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("bots", {
                computerEnabled: false,
                createdAt: 0,
                instructions: "Be brief.",
                model: "gpt-4o",
                name: "Helper",
                ...(permissionMode && { permissionMode }),
                updatedAt: 0,
                userId: OWNER,
            }),
    )) as string;

const chatWith = async (botId: string) => (await as(OWNER).mutation(createThread as never, { botId, model: "gpt-4o" } as never)) as string;

const modeOf = async (table: "bots" | "threads", id: string): Promise<string | undefined> => {
    const row = await harness.run(async (ctx: any) => await ctx.db.get(table, id));

    return row.permissionMode;
};

describe("a new chat with a bot", () => {
    it("starts in the bot's mode, and the chat's mode can still be changed", async () => {
        const threadId = await chatWith(await botWith("supervised"));

        expect(await modeOf("threads", threadId)).toBe("supervised");

        await as(OWNER).mutation(setThreadPermissionMode as never, { mode: "full", threadId } as never);

        expect(await modeOf("threads", threadId)).toBe("full");
        // A bot with no mode leaves its chats on the default.
        expect(await modeOf("threads", await chatWith(await botWith()))).toBeUndefined();
    });

    it("started by an admin acting as the owner never takes full from the bot, and still takes supervised", async () => {
        const full = await botWith("full");
        const supervised = await botWith("supervised");

        impersonation.by = "admin-1";

        expect(await modeOf("threads", await chatWith(full))).toBeUndefined();
        expect(await modeOf("threads", await chatWith(supervised))).toBe("supervised");
    });
});

describe("the bot's mode for an unattended run", () => {
    const read = async (args: { botId?: string; threadId?: string; userId: string }) =>
        await harness.run(async (ctx: any) => await ctx.runQuery(getBotPermissionModeForRun as never, args));

    it("is read for the bot the run names, or the bot of the thread it continues, and only for the bot's owner", async () => {
        const botId = await botWith("supervised");
        const threadId = await chatWith(botId);

        expect(await read({ botId, userId: OWNER })).toBe("supervised");
        expect(await read({ threadId, userId: OWNER })).toBe("supervised");
        expect(await read({ botId, userId: STRANGER })).toBeNull();
        expect(await read({ threadId, userId: STRANGER })).toBeNull();
    });
});

describe("setting a bot's mode", () => {
    it("is refused to an admin impersonating the owner", async () => {
        const botId = await botWith();

        impersonation.by = "admin-1";

        await expect(as(OWNER).mutation(updateBot as never, { botId, patch: { permissionMode: "full" } } as never)).rejects.toThrow("while impersonating");
        await expect(
            as(OWNER).mutation(
                createBot as never,
                { computerEnabled: false, instructions: "x", model: DEFAULT_CHAT_MODEL, name: "n", permissionMode: "full" } as never,
            ),
        ).rejects.toThrow("while impersonating");

        impersonation.by = undefined;

        await as(OWNER).mutation(updateBot as never, { botId, patch: { permissionMode: "full" } } as never);

        expect(await modeOf("bots", botId)).toBe("full");
    });
});
