/**
 * Who may change a project's sub-agent role overrides: the rule of `updateProject` and the rule files, its owner only.
 */
import { lunoraTest } from "@lunora/testing";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import schema from "../schema";
import { getSubAgentRoles } from "../sub-agents/role-settings";
import { setProjectSubAgentRole } from "./functions";

const OWNER = "user-owner";
const MEMBER = "user-member";
const ORG = "org-1";

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

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "projects_functions", await import("./functions"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const insert = async (table: string, fields: Record<string, unknown>) => (await harness.run(async (ctx: any) => await ctx.db.insert(table, fields))) as string;
const as = (userId: string) => harness.withIdentity({ userId });
const setRole = async (userId: string, projectId: string) =>
    await as(userId).mutation(setProjectSubAgentRole as never, { config: { model: DEFAULT_CHAT_MODEL }, projectId, role: "review" } as never);
const editable = async (userId: string, projectId: string) =>
    ((await as(userId).query(getSubAgentRoles as never, { projectId } as never)) as { project: { editable: boolean } | null }).project?.editable;

describe("setProjectSubAgentRole", () => {
    it("lets only the owner change a project's roles: never a member, not even on a project nobody owns", async () => {
        await insert("member", { createdAt: 1, organizationId: ORG, role: "member", userId: MEMBER });

        const owned = await insert("projects", { createdAt: 0, organizationId: ORG, title: "owned", userId: OWNER });
        const shared = await insert("projects", { createdAt: 0, organizationId: ORG, title: "shared" });

        await expect(setRole(OWNER, owned)).resolves.toBeNull();
        await expect(setRole(MEMBER, owned)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(setRole(MEMBER, shared)).rejects.toMatchObject({ code: "NOT_FOUND" });

        expect(await editable(OWNER, owned)).toBe(true);
        expect(await editable(MEMBER, owned)).toBe(false);
        expect(await editable(MEMBER, shared)).toBe(false);
    });
});
