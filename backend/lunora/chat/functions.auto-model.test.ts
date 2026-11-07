/**
 * `updateThread` and Auto: a group chat's turns are taken by its participants, so the owner cannot switch Auto on
 * there. (The paths that go on to write need the preference reads the harness cannot hold.)
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { updateThread } from "./functions";

const OWNER = "user-owner";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, userId: context.auth.userId } : null,
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
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insertThread = async (fields: Record<string, unknown> = {}) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { model: "gpt-4o", status: "active", title: "Chat", userId: OWNER, ...fields }),
    )) as string;

const update = async (threadId: string, args: Record<string, unknown>) =>
    await harness.withIdentity({ userId: OWNER }).action(updateThread as never, { threadId, ...args } as never);

const autoOf = async (threadId: string) => {
    const row = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

    return row?.autoModel as boolean | undefined;
};

describe("updateThread with autoModel", () => {
    it("refuses to turn Auto on in a group chat and leaves the thread as it was", async () => {
        const threadId = await insertThread({ groupChat: { mode: "round-robin", participants: [{ addedAt: 1, skillId: "skill-1" }] } });

        await expect(update(threadId, { autoModel: true })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(autoOf(threadId)).resolves.toBeUndefined();
    });
});

describe("updateThread on a thread with no model", () => {
    const titleOf = async (threadId: string) => {
        const row = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

        return row?.title as string | undefined;
    };

    it("renames it: a title needs no model", async () => {
        const threadId = await insertThread({ model: undefined });

        await update(threadId, { title: "Renamed" });

        await expect(titleOf(threadId)).resolves.toBe("Renamed");
    });

    it("still refuses a change that writes the model", async () => {
        const threadId = await insertThread({ model: undefined });

        await expect(update(threadId, { reasoningEffort: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
        await expect(titleOf(threadId)).resolves.toBe("Chat");
    });
});
