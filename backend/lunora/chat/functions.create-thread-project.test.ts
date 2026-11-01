/**
 * A `projectId` the client names is stored on the new thread, so `createThread` refuses one the caller cannot read.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { getProjectContextForRun } from "../projects/functions";
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
    registerModule(registry, "auth_functions", await import("../auth/functions"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
    registerModule(registry, "projects_functions", await import("../projects/functions"));
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

describe("a project of an organization the caller belongs to", () => {
    const ORG = "org-1";
    const MEMBER = "user-member";
    const orgProject = async () =>
        (await harness.run(
            async (ctx: any) => await ctx.db.insert("projects", { context: "Org notes", createdAt: 0, organizationId: ORG, title: "p", userId: OWNER }),
        )) as string;
    const join = async (userId: string, organizationId = ORG) =>
        await harness.run(async (ctx: any) => await ctx.db.insert("member", { createdAt: 1, organizationId, role: "member", userId }));
    const create = (userId: string, projectId: string) =>
        harness.withIdentity({ userId }).mutation(createThread as never, { model: "gpt-4o", projectId } as never);

    it("lets a member whose active organization differs create a thread in it", async () => {
        const projectId = await orgProject();

        await join(MEMBER);
        await expect(create(MEMBER, projectId)).resolves.toBeDefined();
    });

    it("refuses a user who is not a member of that organization", async () => {
        const projectId = await orgProject();

        await join(STRANGER, "org-other");
        await expect(create(STRANGER, projectId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("hands a member's run the project context, and a non-member none", async () => {
        const projectId = await orgProject();

        await join(MEMBER);

        const read = async (userId: string) =>
            await harness.run(async (ctx: any) => await ctx.runQuery(getProjectContextForRun as never, { projectId, userId }));

        expect(await read(MEMBER)).toBe("Org notes");
        expect(await read(STRANGER)).toBeNull();
    });
});
