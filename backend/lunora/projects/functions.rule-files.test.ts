/**
 * A project's rule files: what a run gets (always files, and pattern files only when the run's files match) and who may
 * change them (the rule of `updateProject`).
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { getProjectContextForRun, listProjectRuleFiles, setProjectRuleFiles } from "./functions";

const OWNER = "user-owner";
const MEMBER = "user-member";
const STRANGER = "user-stranger";
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
    registerModule(registry, "agent_projects", await import("../agent/projects"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const sqlRules = { content: "Use snake_case columns.", globs: ["**/*.sql"], id: "sql", mode: "glob" as const, title: "SQL" };

const insert = async (table: string, fields: Record<string, unknown>) => (await harness.run(async (ctx: any) => await ctx.db.insert(table, fields))) as string;

const chatFile = async (filename: string) =>
    await insert("chatFiles", { filename, hash: filename, lastTouchedAt: 0, mediaType: "text/plain", refcount: 1, storageId: filename });

const contextFor = async (projectId: string, fileIds?: string[]) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getProjectContextForRun as never, { projectId, userId: OWNER, ...(fileIds && { fileIds }) }));

describe("a project's rule files in a run", () => {
    it("adds a **/*.sql file only for a run whose files include SQL", async () => {
        const projectId = await insert("projects", {
            createdAt: 0,
            ruleFiles: [{ content: "Be brief.", id: "a", mode: "always", title: "A" }, sqlRules],
            title: "p",
            userId: OWNER,
        });
        const sql = await chatFile("migrations/001_users.sql");
        const pdf = await chatFile("report.pdf");

        expect(await contextFor(projectId)).toBe("Be brief.");
        expect(await contextFor(projectId, [pdf])).toBe("Be brief.");
        expect(await contextFor(projectId, [pdf, sql])).toBe("Be brief.\n\nUse snake_case columns.");
    });

    it("gives a project that only has its legacy context exactly that text", async () => {
        const context = "Answer in German.\n\nCite sources.";
        const projectId = await insert("projects", { context, createdAt: 0, title: "p", userId: OWNER });

        expect(await contextFor(projectId, [await chatFile("a.sql")])).toBe(context);
    });
});

describe("changing a project's rule files", () => {
    const as = (userId: string) => harness.withIdentity({ userId });
    const list = (userId: string, projectId: string) =>
        as(userId).query(listProjectRuleFiles as never, { projectId } as never) as Promise<{
            canEdit: boolean;
            files: { id: string }[];
            revision: string;
        } | null>;
    // A save from the list as the caller reads it now, unless a revision is named.
    const save = async (userId: string, projectId: string, ruleFiles: unknown[], revision?: string) => {
        const listed = revision === undefined ? await list(userId, projectId) : null;

        return await as(userId).mutation(setProjectRuleFiles as never, { projectId, revision: revision ?? listed?.revision ?? "", ruleFiles } as never);
    };

    it("moves the legacy context into the list on the first save, in the order saved", async () => {
        const projectId = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        const { files } = (await list(OWNER, projectId))!;

        await save(OWNER, projectId, [sqlRules, ...files]);

        const project = (await harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: projectId } }))) as Record<string, unknown>;

        expect(project.context).toBeUndefined();
        expect(project.ruleFiles).toEqual([sqlRules, { content: "Old notes", id: "context", mode: "always", title: "Project context" }]);
        expect(await contextFor(projectId)).toBe("Old notes");
    });

    it("lets the owner, and a member only on a project nobody owns, save; tells a stranger nothing", async () => {
        await insert("member", { createdAt: 1, organizationId: ORG, role: "member", userId: MEMBER });

        const owned = await insert("projects", { createdAt: 0, organizationId: ORG, title: "owned", userId: OWNER });
        const shared = await insert("projects", { createdAt: 0, organizationId: ORG, title: "shared" });

        await expect(save(MEMBER, owned, [sqlRules])).rejects.toMatchObject({ code: "FORBIDDEN" });
        await expect(list(MEMBER, owned)).resolves.toMatchObject({ canEdit: false });
        await expect(save(MEMBER, shared, [sqlRules])).resolves.toBeNull();
        await expect(list(MEMBER, shared)).resolves.toMatchObject({ canEdit: true, files: [{ id: "sql" }] });
        await expect(save(STRANGER, owned, [sqlRules])).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(list(STRANGER, owned)).resolves.toBeNull();
    });

    it("refuses a save from a view older than another save, and keeps that save", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });
        const { revision } = (await list(OWNER, projectId))!;

        await save(OWNER, projectId, [sqlRules], revision);
        await expect(save(OWNER, projectId, [], revision)).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await list(OWNER, projectId))!.files).toMatchObject([{ id: "sql" }]);
    });

    it("refuses a pattern file without a pattern", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });

        await expect(save(OWNER, projectId, [{ ...sqlRules, globs: [] }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });
});
