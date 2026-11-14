/**
 * A temporary chat the composer starts in an organization is not filed under it, so it stays off that organization's
 * list, but it records the organization for its cap (`threads.capOrganizationId`), so a later turn from another space
 * keeps it capped.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

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

const { default: schema } = await import("../schema");
const threads = await import("../agent/threads");
const { createThreadWithInitialMessage } = await import("./functions");

let harness: ReturnType<typeof lunoraTest>;

const start = async (fields: Record<string, unknown>): Promise<Record<string, unknown>> =>
    await harness.run(async (ctx: any) => {
        const { threadId } = await ctx.runMutation(createThreadWithInitialMessage, {
            messageContent: [{ text: "hi", type: "text" }],
            model: "openai/gpt-4.1-mini",
            userId: "owner",
            ...fields,
        });

        return await ctx.db.get("threads", threadId);
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

describe("createThreadWithInitialMessage", () => {
    it("keeps a temporary chat's organization for its cap only, off that organization's list", async () => {
        const thread = await start({ organizationId: "org-a", temporary: true });

        expect(thread).toMatchObject({ capOrganizationId: "org-a", isTemporary: true });
        expect(thread).not.toHaveProperty("organizationId");
    });

    it("files a lasting chat under its organization, with no separate cap organization", async () => {
        const thread = await start({ organizationId: "org-a" });

        expect(thread).toMatchObject({ organizationId: "org-a" });
        expect(thread).not.toHaveProperty("capOrganizationId");
    });
});
