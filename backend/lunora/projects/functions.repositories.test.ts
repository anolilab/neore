/**
 * A project's repository list: set by its owner only, stored normalised, and returned with the project.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { listProjects, setProjectRepositories } from "./functions";

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
    registerModule(registry, "projects_functions", await import("./functions"));
    registerModule(registry, "agent_projects", await import("../agent/projects"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("setProjectRepositories", () => {
    const projectOf = async (userId: string) =>
        (await harness.run(async (ctx: any) => await ctx.db.insert("projects", { createdAt: 0, title: "p", userId }))) as string;
    const set = (userId: string, projectId: string, repositories: unknown[]) =>
        harness.withIdentity({ userId }).mutation(setProjectRepositories as never, { projectId, repositories } as never);

    it("stores two repositories, the first as the default, and lists them with the project", async () => {
        const projectId = await projectOf(OWNER);

        await set(OWNER, projectId, [{ url: "acme/web" }, { defaultBranch: "develop", url: "acme/api" }]);

        const page = (await harness
            .withIdentity({ userId: OWNER })
            .query(listProjects as never, { paginationOpts: { cursor: null, numItems: 10 } } as never)) as { page: { repositories?: unknown[] }[] };

        expect(page.page[0]?.repositories).toMatchObject([
            { isDefault: true, url: "https://github.com/acme/web.git" },
            { defaultBranch: "develop", url: "https://github.com/acme/api.git" },
        ]);
    });

    it("refuses anyone but the owner, without saying the project exists", async () => {
        await expect(set(STRANGER, await projectOf(OWNER), [{ url: "acme/web" }])).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses an invalid repository with a message", async () => {
        await expect(set(OWNER, await projectOf(OWNER), [{ url: "ssh://example.com/x" }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});
