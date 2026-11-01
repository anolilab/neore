/**
 * A `projectId` the client names is stored on the new thread, so `createThread` refuses one the caller cannot read.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { createThread } from "./functions";

const OWNER = "user-owner";
const STRANGER = "user-stranger";

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
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("createThread with a projectId", () => {
    const projectOf = async (userId: string) =>
        (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, title: "p", userId }))) as string;
    const create = (userId: string, projectId: string) =>
        harness.withIdentity({ userId }).mutation(createThread as never, { model: "gpt-4o", projectId } as never);

    it("refuses a project another user owns", async () => {
        await expect(create(STRANGER, await projectOf(OWNER))).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("refuses a project that does not exist", async () => {
        const gone = await projectOf(OWNER);

        await harness.run(async (ctx: any) => await ctx.db.delete(gone));
        await expect(create(OWNER, gone)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
});
