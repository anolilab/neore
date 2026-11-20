/**
 * A bot's tool selection as stored and as a run reads it: normalized on save, cleared with null, refused to an admin acting as
 * the owner, and found for the bot's own runs, its threads and the sub-agents under them.
 */
import { lunoraTest } from "@lunora/testing";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { createThread } from "../chat/functions";
import { createBot, getBotToolSelectionForRun, updateBot } from "./functions";
import { mcpServerKey } from "./tool-selectors";

const OWNER = "user-owner";
const DOCS = mcpServerKey("https://docs.example/mcp") ?? "";

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

const created = async (toolSelection?: unknown) =>
    (await as(OWNER).mutation(
        createBot as never,
        { computerEnabled: false, instructions: "x", model: DEFAULT_CHAT_MODEL, name: "n", ...(toolSelection !== undefined && { toolSelection }) } as never,
    )) as string;

const selectionOf = async (botId: string): Promise<unknown> => {
    const row = await harness.run(async (ctx: any) => await ctx.db.get("bots", botId));

    return row.toolSelection;
};

const read = async (args: { botId?: string; threadId?: string }) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getBotToolSelectionForRun as never, args));

describe("a bot's tool selection", () => {
    it("is stored normalized on create and update, and cleared back to every tool with null", async () => {
        const botId = await created({ allow: [" webSearch ", "webSearch"], exclude: [`${DOCS}:*`] });

        expect(await selectionOf(botId)).toStrictEqual({ allow: ["webSearch"], exclude: [`${DOCS}:*`] });
        expect(await selectionOf(await created())).toBeUndefined();

        await as(OWNER).mutation(updateBot as never, { botId, patch: { toolSelection: { allow: [], exclude: [] } } } as never);

        expect(await selectionOf(botId)).toStrictEqual({ allow: [], exclude: [] });

        await as(OWNER).mutation(updateBot as never, { botId, patch: { toolSelection: null } } as never);

        expect(await selectionOf(botId)).toBeUndefined();
    });

    it("refuses a selector with control characters or naming no built-in, and any change by an admin impersonating the owner", async () => {
        await expect(created({ exclude: [`${DOCS}:\nsearch`] })).rejects.toThrow("Invalid tool selector");
        // A server named by its display name would stop matching on a rename.
        await expect(created({ exclude: ["docs:*"] })).rejects.toThrow("Invalid tool selector");
        // A mistyped built-in would exclude nothing, so the bot would keep the tool its owner meant to remove.
        await expect(created({ exclude: ["webSerch"] })).rejects.toThrow("No built-in tool is named webSerch");

        const botId = await created({ allow: [], exclude: [] });

        impersonation.by = "admin-1";

        await expect(as(OWNER).mutation(updateBot as never, { botId, patch: { toolSelection: null } } as never)).rejects.toThrow("while impersonating");
        expect(await selectionOf(botId)).toStrictEqual({ allow: [], exclude: [] });
        // Nor can the admin create a bot with a selection: the same rule as an update.
        await expect(created({ exclude: [`${DOCS}:*`] })).rejects.toThrow("while impersonating");
        // A bot without one is created as before.
        expect(await selectionOf(await created())).toBeUndefined();
    });

    it("logs one event per change of a selection, with the bot and counts, never the selectors", async () => {
        const log = (await harness.run(async (ctx: any) => ctx.log)) as { event: (...args: unknown[]) => void };
        const events: unknown[] = [];

        vi.spyOn(log, "event").mockImplementation((name: unknown, fields: unknown) => {
            if (name === "bots.bot_tool_selection_changed") {
                events.push(fields);
            }
        });

        const botId = await created({ allow: ["webSearch"], exclude: [`${DOCS}:*`] });

        await as(OWNER).mutation(updateBot as never, { botId, patch: { toolSelection: { allow: ["webSearch"], exclude: [`${DOCS}:*`] } } } as never);
        await as(OWNER).mutation(updateBot as never, { botId, patch: { name: "renamed" } } as never);
        await as(OWNER).mutation(updateBot as never, { botId, patch: { toolSelection: null } } as never);
        await created();

        expect(events).toStrictEqual([
            { botId, fromAllowed: "all", fromExcluded: 0, toAllowed: 1, toExcluded: 1 },
            { botId, fromAllowed: 1, fromExcluded: 1, toAllowed: "all", toExcluded: 0 },
        ]);
        expect(JSON.stringify(events)).not.toContain("docs.example");
    });

    it("is read for a run of the bot, of its thread and of a sub-agent under it, whoever runs the turn", async () => {
        const botId = await created({ allow: ["webSearch"], exclude: [] });
        const threadId = (await as(OWNER).mutation(createThread as never, { botId, model: "gpt-4o" } as never)) as string;
        const childThreadId = (await harness.run(async (ctx: any) => {
            const child = await ctx.db.insert("threads", { status: "active", title: "Child", userId: OWNER });

            await ctx.db.insert("subAgentRuns", {
                childThreadId: child,
                createdAt: 0,
                depth: 1,
                parentThreadId: threadId,
                status: "running",
                task: "t",
                updatedAt: 0,
                userId: OWNER,
            });

            return child;
        })) as string;
        const expected = { ownerId: OWNER, ownerServerKeys: [], selection: { allow: ["webSearch"], exclude: [] } };

        // No caller is named: a write collaborator's turn in the owner's bot chat is narrowed by the owner's selection too.
        expect(await read({ botId })).toStrictEqual(expected);
        expect(await read({ threadId })).toStrictEqual(expected);
        expect(await read({ threadId: childThreadId })).toStrictEqual(expected);
        // A bot with no selection keeps every tool.
        expect(await read({ botId: await created() })).toBeNull();
    });

    it("reads the owner's saved server keys with a selection that excludes a user server, so a collaborator's run can tell a stale one", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("aiUserPreferences", {
                mcpServers: [{ enabled: false, name: "docs", protocol: "http", url: "https://docs.example/mcp" }],
                userId: OWNER,
            });
        });

        const botId = await created({ exclude: [`${DOCS}:*`] });

        expect(await read({ botId })).toStrictEqual({ ownerId: OWNER, ownerServerKeys: [DOCS], selection: { exclude: [`${DOCS}:*`] } });
    });

    it("follows a sub-agent child to its lead after the run's row was pruned, by the child's link", async () => {
        const botId = await created({ exclude: ["webSearch"] });
        const threadId = (await as(OWNER).mutation(createThread as never, { botId, model: "gpt-4o" } as never)) as string;
        const childThreadId = (await harness.run(async (ctx: any) => {
            const child = await ctx.db.insert("threads", { status: "active", title: "Child", userId: OWNER });

            await ctx.db.insert("threadRelationships", {
                branchPoint: 0,
                branchType: "subagent",
                createdAt: 0,
                parentThreadId: threadId,
                threadId: child,
                userId: OWNER,
            });

            return child;
        })) as string;

        expect(await read({ threadId: childThreadId })).toStrictEqual({ ownerId: OWNER, ownerServerKeys: [], selection: { exclude: ["webSearch"] } });
    });

    it("gives no tools for a thread it cannot read, and every tool for a plain chat", async () => {
        const plainThreadId = (await harness.run(
            async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Plain", userId: OWNER }),
        )) as string;

        expect(await read({ threadId: "not-a-thread" })).toStrictEqual({ ownerId: "", ownerServerKeys: [], selection: { allow: [], exclude: [] } });
        expect(await read({ threadId: plainThreadId })).toBeNull();
    });
});
