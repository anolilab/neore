/**
 * A project's rule files: what a run gets (always files, and pattern files only when the run's files match) and who may
 * change them (the rule of `updateProject`: its owner only).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import {
    deleteProject as eraseProject,
    getProject as getOwnProject,
    listPinnedProjects as listOwnPinned,
    updateProject as writeProject,
} from "../agent/projects";
import { deleteUserProjects } from "../gdpr/steps/deletion-steps";
import schema from "../schema";
import { runProjectFor } from "../tasks/internal";
import { getWorkflow } from "../workflow/functions";
import {
    getProject,
    getProjectContextForRun,
    listPinnedProjects,
    listProjectRuleFiles,
    listProjects,
    RUN_FILE_NAMES_READ_BYTES,
    setProjectRuleFiles,
    updateProject,
} from "./functions";
import { markRuleFilesSaved } from "../agent/table-writes";
import {
    collectProjectRuleFilesForExport,
    eraseProjectRuleFiles,
    eraseProjectRuleFilesForUser,
    eraseProjectsRuleFiles,
    markProjectRuleFilesErasing,
    RULE_FILE_ROWS_PER_PAGE,
    sweepUnfinishedRuleFileErasures,
} from "./gdpr";
import { DELETION_MARKER_TTL_MS, DELETION_MARKER_URL } from "./repositories";
import { readProjectRuleFiles, ruleFileRow, writeProjectRuleFiles } from "./rule-file-rows";
import { MAX_RULE_GLOB_LENGTH, MAX_RULE_GLOBS, MAX_RULE_TITLE_LENGTH, RULE_FILE_REFUSALS } from "./rule-file-limits";
import { contextFingerprint, MAX_RULE_TEXT_PER_RUN } from "./rule-files";

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

// Counts the reads of the rule-file table, which only the editor, a run's setup and a save make.
vi.mock("./rule-file-rows", async (importOriginal) => {
    const original = await importOriginal<typeof import("./rule-file-rows")>();

    return { ...original, readProjectRuleFiles: vi.fn(original.readProjectRuleFiles), writeProjectRuleFiles: vi.fn(original.writeProjectRuleFiles) };
});

// Fails once where a test says, to leave a save half done.
vi.mock("../agent/table-writes", async (importOriginal) => {
    const original = await importOriginal<typeof import("../agent/table-writes")>();

    return { ...original, markRuleFilesSaved: vi.fn(original.markRuleFilesSaved) };
});

// Watched for when a project's delete erases its rule files.
vi.mock("./gdpr", async (importOriginal) => {
    const original = await importOriginal<typeof import("./gdpr")>();

    return {
        ...original,
        eraseProjectRuleFiles: vi.fn(original.eraseProjectRuleFiles),
        eraseProjectsRuleFiles: vi.fn(original.eraseProjectsRuleFiles),
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
    registerModule(registry, "gdpr_steps_deletion_steps", await import("../gdpr/steps/deletion-steps"));
}, 30_000);

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.mocked(readProjectRuleFiles).mockClear();
});

const sqlRules = { content: "Use snake_case columns.", globs: ["**/*.sql"], id: "sql", mode: "glob" as const, title: "SQL" };

const insert = async (table: string, fields: Record<string, unknown>) => (await harness.run(async (ctx: any) => await ctx.db.insert(table, fields))) as string;

/** A project, with `ruleFiles` saved in their own table. */
const project = async ({ ruleFiles, ...fields }: Record<string, unknown> & { ruleFiles?: unknown[] }) => {
    const projectId = await insert("projects", fields);

    if (ruleFiles) {
        await insert("projectRuleFiles", { files: ruleFiles, projectId, updatedAt: 0, ...(typeof fields.userId === "string" && { userId: fields.userId }) });
    }

    return projectId;
};

/** The files saved in the rule-file table for `projectId`, `undefined` without a row. */
const savedFiles = async (projectId: string) =>
    (await harness.run(async (ctx: any) => {
        const saved = await ctx.db.projectRuleFiles.findFirst({ where: { projectId } });

        return saved?.files;
    })) as unknown[] | undefined;

/** The rule-file row of `projectId`, `null` without one. */
const ruleRow = async (projectId: string) =>
    (await harness.run(async (ctx: any) => await ctx.db.projectRuleFiles.findFirst({ where: { projectId } }))) as Record<string, unknown> | null;

const chatFile = async (filename: string) =>
    await insert("chatFiles", { filename, hash: filename, lastTouchedAt: 0, mediaType: "text/plain", refcount: 1, storageId: filename });

const contextFor = async (projectId: string, fileIds?: string[]) =>
    await harness.run(async (ctx: any) => await ctx.runQuery(getProjectContextForRun as never, { projectId, userId: OWNER, ...(fileIds && { fileIds }) }));

describe("a project's rule files in a run", () => {
    it("adds a **/*.sql file only for a run whose files include SQL", async () => {
        const projectId = await project({
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

    it("stops reading attachment names past the read budget and runs with what it matched so far", async () => {
        const projectId = await project({
            createdAt: 0,
            ruleFiles: [{ content: "Be brief.", id: "a", mode: "always", title: "A" }, sqlRules],
            title: "p",
            userId: OWNER,
        });
        // Charged whole, extracted text included: this one row spends the budget.
        const large = await insert("chatFiles", {
            extractedText: "x".repeat(RUN_FILE_NAMES_READ_BYTES),
            filename: "scan.pdf",
            hash: "large",
            lastTouchedAt: 0,
            mediaType: "application/pdf",
            refcount: 1,
            storageId: "large",
        });
        const sql = await chatFile("migrations/002_orders.sql");

        expect(await contextFor(projectId, [sql, large])).toBe("Be brief.\n\nUse snake_case columns.");
        expect(await contextFor(projectId, [large, sql])).toBe("Be brief.");
    });

    it("reads attachment names on the primary, so a file uploaded just before the run still matches", async () => {
        const projectId = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "p", userId: OWNER });
        const sql = await chatFile("migrations/003_fresh.sql");

        // A replica that has not seen the upload yet: only the primary has the row.
        const result = await harness.run(async (ctx: any) => {
            const findFirst = async (query: { consistency?: string }) => (query.consistency === "primary" ? await ctx.db.chatFiles.findFirst(query) : null);
            const chatFiles = new Proxy(ctx.db.chatFiles, { get: (target, key) => (key === "findFirst" ? findFirst : target[key]) });
            const db = new Proxy(ctx.db, { get: (target, key) => (key === "chatFiles" ? chatFiles : target[key]) });

            return await (getProjectContextForRun as any).handler({ ...ctx, db }, { fileIds: [sql], projectId, userId: OWNER });
        });

        expect(result).toBe("Use snake_case columns.");
    });

    it("gives a task's run its project's always files, read on the primary as a chat's are", async () => {
        const projectId = await project({
            createdAt: 0,
            ruleFiles: [{ content: "Be brief.", id: "a", mode: "always", title: "A" }, sqlRules],
            title: "p",
            userId: OWNER,
        });
        const taskId = await insert("tasks", {
            attemptCount: 0,
            createdAt: 0,
            dependsOn: [],
            instructions: "Do it.",
            maxRepairRounds: 0,
            projectId,
            recurring: false,
            title: "t",
            updatedAt: 0,
            userId: OWNER,
        });

        await expect(harness.run(async (ctx: any) => await ctx.runQuery(runProjectFor as never, { taskId }))).resolves.toStrictEqual({
            context: "Be brief.",
            projectId,
        });
        expect(await contextFor(projectId)).toBe("Be brief.");
        // On the primary for a task and a chat alike: the first save clears `context` as it writes the list, so a project row
        // and a rule-file row read from replicas at different points could leave the run no instructions.
        expect(vi.mocked(readProjectRuleFiles).mock.calls.map((call) => call[2])).toStrictEqual([{ primary: true }, { primary: true }]);
    });

    it("holds a chat run and a task run to the same rule-text cap, separators and marker included", async () => {
        const ruleFiles = Array.from({ length: 5 }, (_, index) => {
            return { content: String(index).repeat(60_000), id: `f${index}`, mode: "always", title: `F${index}` };
        });
        const projectId = await project({ createdAt: 0, ruleFiles, title: "p", userId: OWNER });
        const taskId = await insert("tasks", {
            attemptCount: 0,
            createdAt: 0,
            dependsOn: [],
            instructions: "Do it.",
            maxRepairRounds: 0,
            projectId,
            recurring: false,
            title: "t",
            updatedAt: 0,
            userId: OWNER,
        });
        const chat = (await contextFor(projectId)) as string;
        const task = (await harness.run(async (ctx: any) => await ctx.runQuery(runProjectFor as never, { taskId }))) as { context: string };

        expect(chat).toContain("truncated");
        expect(chat.length).toBeLessThanOrEqual(MAX_RULE_TEXT_PER_RUN);
        expect(task.context).toBe(chat);
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
    const save = async (userId: string, projectId: string, ruleFiles: unknown[], revision?: string, extra: Record<string, unknown> = {}) => {
        const listed = revision === undefined ? await list(userId, projectId) : null;

        return await as(userId).mutation(
            setProjectRuleFiles as never,
            { projectId, revision: revision ?? listed?.revision ?? "", ruleFiles, ...extra } as never,
        );
    };
    const row = async (projectId: string) =>
        (await harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: projectId } }))) as Record<string, unknown>;

    it("moves the legacy context into the list on the first save, in the order saved", async () => {
        const projectId = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        const { files } = (await list(OWNER, projectId))!;

        await save(OWNER, projectId, [sqlRules, ...files]);

        await expect(row(projectId)).resolves.toMatchObject({ context: "" });
        await expect(savedFiles(projectId)).resolves.toEqual([sqlRules, { content: "Old notes", id: "context", mode: "always", title: "Project context" }]);
        expect(await contextFor(projectId)).toBe("Old notes");
    });

    it("lets only the owner save, as updateProject: never a member, not even on a project nobody owns", async () => {
        await insert("member", { createdAt: 1, organizationId: ORG, role: "member", userId: MEMBER });

        const owned = await insert("projects", { createdAt: 0, organizationId: ORG, title: "owned", userId: OWNER });
        const shared = await insert("projects", { createdAt: 0, organizationId: ORG, title: "shared" });

        const { revision } = (await save(OWNER, owned, [sqlRules])) as { revision: string };

        await expect(list(OWNER, owned)).resolves.toMatchObject({ canEdit: true, files: [{ id: "sql" }], revision });
        await expect(save(MEMBER, owned, [], (await list(OWNER, owned))!.revision)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(list(MEMBER, owned)).resolves.toMatchObject({ canEdit: false, files: [{ id: "sql" }] });
        await expect(save(MEMBER, shared, [sqlRules])).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(list(MEMBER, shared)).resolves.toMatchObject({ canEdit: false, files: [] });
        await expect(save(STRANGER, owned, [sqlRules])).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(list(STRANGER, owned)).resolves.toBeNull();
    });

    it("keeps updateProject to the owner: a member is refused on an owned and on an ownerless project", async () => {
        await insert("member", { createdAt: 1, organizationId: ORG, role: "member", userId: MEMBER });

        const owned = await insert("projects", { createdAt: 0, organizationId: ORG, title: "owned", userId: OWNER });
        const shared = await insert("projects", { createdAt: 0, organizationId: ORG, title: "shared" });
        const rename = (userId: string, projectId: string) => as(userId).mutation(updateProject as never, { patch: { title: "renamed" }, projectId } as never);

        await expect(rename(OWNER, owned)).resolves.toBe(owned);
        await expect(rename(MEMBER, owned)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(rename(MEMBER, shared)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(rename(STRANGER, owned)).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("keeps an unchanged context longer than a rule file in place, and saves the other files", async () => {
        const context = "x".repeat(150_000);
        const projectId = await insert("projects", { context, createdAt: 0, title: "p", userId: OWNER });

        await expect(list(OWNER, projectId)).resolves.toMatchObject({ legacyContextId: "context" });
        const { files, revision } = (await save(OWNER, projectId, [sqlRules], undefined, { keepContext: true })) as { files: unknown[]; revision: string };

        expect(files).toStrictEqual([sqlRules]);

        expect(await row(projectId)).toMatchObject({ context });
        await expect(savedFiles(projectId)).resolves.toStrictEqual([sqlRules]);
        await expect(list(OWNER, projectId)).resolves.toMatchObject({ files: [{ id: "context" }, { id: "sql" }], revision });
    });

    it("saves a changed context sent with keepContext instead of dropping it, and clears the old one", async () => {
        const context = "x".repeat(150_000);
        const projectId = await insert("projects", { context, createdAt: 0, title: "p", userId: OWNER });
        const changed = { content: "Short now.", id: "context", mode: "always" as const, title: "Project context" };

        await save(OWNER, projectId, [changed, sqlRules], undefined, { keepContext: true });

        await expect(row(projectId)).resolves.toMatchObject({ context: "" });
        await expect(savedFiles(projectId)).resolves.toStrictEqual([changed, sqlRules]);
        expect(await contextFor(projectId)).toBe("Short now.");
    });

    it("keeps a saved file named like the kept context, which reads under another id beside it", async () => {
        const mine = { content: "Mine.", id: "context", mode: "always" as const, title: "Mine" };
        const projectId = await project({ context: "x".repeat(150_000), createdAt: 0, ruleFiles: [mine], title: "p", userId: OWNER });
        const { files, legacyContextId } = (await list(OWNER, projectId)) as unknown as { files: { id: string }[]; legacyContextId: string };

        expect(legacyContextId).not.toBe("context");
        // The editor leaves the kept context out of what it sends.
        await save(
            OWNER,
            projectId,
            files.filter((file) => file.id !== legacyContextId),
            undefined,
            { keepContext: true },
        );
        await expect(savedFiles(projectId)).resolves.toStrictEqual([mine]);
    });

    it("saves a full list beside a large workflow, the project row left as it was", async () => {
        const big = Array.from({ length: 5 }, (_, index) => {
            return { content: "y".repeat(99_000), id: `f${index}`, mode: "always", title: "t" };
        });
        const workflowContent = { edges: [], nodes: [{ data: { prompt: "w".repeat(1_500_000) }, id: "n", position: { x: 0, y: 0 }, type: "text" }] };
        const withWorkflow = await insert("projects", { createdAt: 0, title: "w", userId: OWNER, workflowContent });

        await expect(save(OWNER, withWorkflow, big)).resolves.toMatchObject({ revision: expect.any(String) });
        await expect(savedFiles(withWorkflow)).resolves.toStrictEqual(big);
        expect(await row(withWorkflow)).toMatchObject({ workflowContent });
        expect(await row(withWorkflow)).not.toHaveProperty("ruleFiles");
    });

    it("re-checks the owner in the writing transaction", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });
        const write = (settingsEditorId: string) =>
            harness.run(async (ctx: any) => await ctx.runMutation(writeProject as never, { patch: { title: "t" }, projectId, settingsEditorId }));

        await expect(write(MEMBER)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(write(OWNER)).resolves.toMatchObject({ title: "t" });
    });

    it("reads no rule files for project lists and single-project reads; the editor and a run do", async () => {
        // The lists name their caller through a user row.
        const owner = await insert("user", { createdAt: 0, email: "owner@example.com", emailVerified: true, name: "Owner", updatedAt: 0 });
        const projectId = await project({ context: "Old notes", createdAt: 0, pinnedAt: 1, ruleFiles: [sqlRules], title: "p", userId: owner });
        const workflowId = await project({
            createdAt: 0,
            projectType: "workflow",
            ruleFiles: [sqlRules],
            title: "w",
            userId: owner,
            workflowContent: { edges: [], nodes: [] },
        });
        const { page } = (await as(owner).query(listProjects as never, { paginationOpts: { cursor: null, numItems: 10 } } as never)) as { page: object[] };

        expect(page).toHaveLength(2);
        await as(owner).query(listPinnedProjects as never, {} as never);
        await as(owner).query(listOwnPinned as never, {} as never);
        await expect(as(owner).query(getProject as never, { projectId } as never)).resolves.toMatchObject({ context: "Old notes", title: "p" });
        await as(owner).query(getOwnProject as never, { projectId } as never);
        await expect(as(owner).query(getWorkflow as never, { projectId: workflowId } as never)).resolves.toMatchObject({ _id: workflowId, title: "w" });
        expect(readProjectRuleFiles).not.toHaveBeenCalled();

        await expect(list(owner, projectId)).resolves.toMatchObject({ files: [{ id: "context" }, { id: "sql" }] });
        await expect(harness.run(async (ctx: any) => await ctx.runQuery(getProjectContextForRun as never, { projectId, userId: owner }))).resolves.toBe(
            "Old notes",
        );
        expect(readProjectRuleFiles).toHaveBeenCalledTimes(2);
    });

    it("deletes a project's rule files with the project, and with the owner's account", async () => {
        const kept = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "kept", userId: OWNER });
        const deleted = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "deleted", userId: OWNER });

        const projectAtErase: unknown[] = [];

        vi.mocked(eraseProjectRuleFiles).mockImplementationOnce(async (ctx, projectId) => {
            projectAtErase.push(await ctx.db.projects.findFirst({ where: { _id: projectId } }));
            // Marked before the project row went, so a sweep finishes an erase that fails here.
            const marked = await ctx.db.projectRuleFiles.findFirst({ where: { projectId } });

            expect(marked?.deletingAt).toBeGreaterThan(0);
            const { eraseProjectRuleFiles: erase } = await vi.importActual<typeof import("./gdpr")>("./gdpr");

            await erase(ctx, projectId);
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(eraseProject as never, { projectId: deleted }));

        // Only once the project row is gone: a delete failing before it never leaves a live project without its rules.
        expect(projectAtErase).toStrictEqual([null]);
        await expect(savedFiles(deleted)).resolves.toBeUndefined();
        await expect(savedFiles(kept)).resolves.toStrictEqual([sqlRules]);

        await harness.run(async (ctx: any) => await eraseProjectRuleFiles(ctx, kept as never));

        await expect(savedFiles(kept)).resolves.toBeUndefined();

        // The account's last project step takes the rule files with each page of projects, a row saved after the earlier
        // step too, once the project rows are gone, as a delete does.
        const last = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "last", userId: OWNER });

        vi.mocked(eraseProjectsRuleFiles).mockImplementationOnce(async (ctx, projectIds) => {
            // `kept` too, whose rule files went above.
            expect(new Set(projectIds)).toStrictEqual(new Set([kept, last]));

            for (const projectId of projectIds) {
                projectAtErase.push(await ctx.db.projects.findFirst({ where: { _id: projectId } }));
            }

            // Marked before the project row went.
            const marked = await ctx.db.projectRuleFiles.findFirst({ where: { projectId: last as never } });

            expect(marked?.deletingAt).toBeGreaterThan(0);

            const { eraseProjectsRuleFiles: erase } = await vi.importActual<typeof import("./gdpr")>("./gdpr");

            await erase(ctx, projectIds);
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserProjects as never, { userId: OWNER }));

        expect(projectAtErase).toStrictEqual([null, null, null]);
        await expect(savedFiles(last)).resolves.toBeUndefined();
    });

    it("erases the rule files a failed project page left once the account has no project left", async () => {
        const owned = await Promise.all(
            Array.from(
                { length: 3 },
                async (_, index) => await project({ createdAt: index, ruleFiles: [sqlRules], title: `p${String(index)}`, userId: OWNER }),
            ),
        );
        const theirs = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "theirs", userId: STRANGER });

        // A round that failed after its project deletes: a `.global()` write does not roll back, so the rows stay marked.
        await harness.run(async (ctx: any) => {
            for (const projectId of owned) {
                await markProjectRuleFilesErasing(ctx, projectId as never);
                await ctx.db.delete("projects", projectId);
            }
        });

        // The retry finds no project of theirs and erases the rows by owner.
        await expect(harness.run(async (ctx: any) => await ctx.runMutation(deleteUserProjects as never, { userId: OWNER }))).resolves.toStrictEqual({
            hasMore: false,
        });

        for (const projectId of owned) {
            await expect(ruleRow(projectId)).resolves.toBeNull();
        }

        await expect(savedFiles(theirs)).resolves.toStrictEqual([sqlRules]);
    });

    it("erases an account's projects a page per step, each page's rule files with it, until none are left", async () => {
        const count = RULE_FILE_ROWS_PER_PAGE * 2 + 3;
        const owned = await Promise.all(
            Array.from(
                { length: count },
                async (_, index) => await project({ createdAt: index, ruleFiles: [sqlRules], title: `p${String(index)}`, userId: OWNER }),
            ),
        );
        const theirs = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "theirs", userId: STRANGER });
        const results: { hasMore: boolean }[] = [];

        vi.mocked(eraseProjectsRuleFiles).mockClear();

        for (let step = 0; step < 10; step += 1) {
            const result = (await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserProjects as never, { userId: OWNER }))) as {
                hasMore: boolean;
            };

            results.push(result);

            if (!result.hasMore) {
                break;
            }
        }

        // Two full pages, then the last three: no step reads or writes more than a page.
        expect(results.map((result) => result.hasMore)).toStrictEqual([true, true, false]);
        expect(vi.mocked(eraseProjectsRuleFiles).mock.calls.map(([, projectIds]) => projectIds.length)).toStrictEqual([
            RULE_FILE_ROWS_PER_PAGE,
            RULE_FILE_ROWS_PER_PAGE,
            3,
        ]);

        for (const projectId of owned) {
            await expect(savedFiles(projectId)).resolves.toBeUndefined();
            await expect(harness.run(async (ctx: any) => await ctx.db.projects.findFirst({ where: { _id: projectId } }))).resolves.toBeNull();
        }

        await expect(savedFiles(theirs)).resolves.toStrictEqual([sqlRules]);
    });

    it("marks the project changed on every save, a list without a context too", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", updatedAt: 0, userId: OWNER });

        await save(OWNER, projectId, [sqlRules]);

        await expect(row(projectId)).resolves.toMatchObject({ updatedAt: expect.any(Number) });
        await expect(row(projectId)).resolves.not.toMatchObject({ updatedAt: 0 });
    });

    it("exports the saved files of the user's own projects only, and counts the rule-file rows it read", async () => {
        const mine = await project({ createdAt: 0, ruleFiles: [{ ...sqlRules, content: "z".repeat(50_000) }], title: "mine", userId: OWNER });
        const theirs = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "theirs", userId: STRANGER });
        const exported = (await harness.run(
            async (ctx: any) => await ctx.runQuery(collectProjectRuleFilesForExport as never, { projectIds: [mine, theirs], userId: OWNER }),
        )) as { projects: { projectId: string; ruleFiles: { content: string }[] }[]; readBytes: number };

        expect(exported.projects).toHaveLength(1);
        expect(exported.projects[0]).toMatchObject({ projectId: mine, ruleFiles: [{ content: "z".repeat(50_000) }] });
        expect(exported.readBytes).toBeGreaterThan(50_000);
    });

    it("refuses a save from a view older than another save, and keeps that save", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });
        const { revision } = (await list(OWNER, projectId))!;

        await save(OWNER, projectId, [sqlRules], revision);
        await expect(save(OWNER, projectId, [], revision)).rejects.toMatchObject({ code: "CONFLICT" });
        expect((await list(OWNER, projectId))!.files).toMatchObject([{ id: "sql" }]);
    });

    it("writes only over the row a save compared against: the second of two saves that read it is refused", async () => {
        const projectId = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "p", userId: OWNER });
        const owner = { _id: projectId, userId: OWNER };
        const write = async (read: unknown, files: unknown[]) =>
            await harness.run(
                async (ctx: any) =>
                    await writeProjectRuleFiles({ db: ctx.db, now: 1 } as never, owner as never, read as never, { carriedContext: "", files: files as never }),
            );
        const read = await harness.run(async (ctx: any) => await ruleFileRow(ctx, projectId as never, { primary: true }));

        await write(read, []);
        await expect(write(read, [sqlRules])).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(savedFiles(projectId)).resolves.toStrictEqual([]);
        // A first save that found no row, over a row written since: refused by the unique index, as stale.
        await expect(write(null, [sqlRules])).rejects.toMatchObject({ code: "CONFLICT" });
        await expect(savedFiles(projectId)).resolves.toStrictEqual([]);
    });

    it("takes no save while the project's delete is under way, and takes back one its delete overtook", async () => {
        const deleting = await insert("projects", { createdAt: 0, title: "deleting", userId: OWNER });
        const { revision } = (await list(OWNER, deleting))!;

        await insert("projectRepositories", { createdAt: 0, deletingAt: Date.now(), projectId: deleting, url: DELETION_MARKER_URL, userId: OWNER });

        await expect(save(OWNER, deleting, [sqlRules], revision)).rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(savedFiles(deleting)).resolves.toBeUndefined();

        // Deleted between the save's check and its write: the delete's erase may have run first, so the save erases its own.
        const overtaken = await insert("projects", { createdAt: 0, title: "overtaken", userId: OWNER });
        const actual = await vi.importActual<typeof import("./rule-file-rows")>("./rule-file-rows");

        vi.mocked(writeProjectRuleFiles).mockImplementationOnce(async (ctx, ...rest) => {
            await actual.writeProjectRuleFiles(ctx, ...rest);
            await ctx.db.delete("projects", overtaken as never);
        });

        vi.mocked(eraseProjectRuleFiles).mockClear();

        await expect(save(OWNER, overtaken, [sqlRules])).rejects.toMatchObject({ code: "NOT_FOUND" });
        // Erased by the save itself: a `.global()` write is not rolled back with the refusal, as the harness rolls it back.
        expect(eraseProjectRuleFiles).toHaveBeenCalledWith(expect.anything(), overtaken);
        await expect(savedFiles(overtaken)).resolves.toBeUndefined();
    });

    it("never reads a context twice when the save that carried it failed to clear it, and a retry clears it", async () => {
        const projectId = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        const { files } = (await list(OWNER, projectId))!;

        // The clear lost (a `.global()` write that failed after the list's committed, which the harness would roll back).
        vi.mocked(markRuleFilesSaved).mockResolvedValueOnce();

        await save(OWNER, projectId, [sqlRules, ...files]);
        // The list holds the context; the project still has it, read once, as the list's own file.
        await expect(row(projectId)).resolves.toMatchObject({ context: "Old notes" });
        expect((await list(OWNER, projectId))!.files.map((file) => file.id)).toStrictEqual(["sql", "context"]);
        expect(await contextFor(projectId)).toBe("Old notes");

        await save(OWNER, projectId, (await list(OWNER, projectId))!.files);

        await expect(row(projectId)).resolves.toMatchObject({ context: "" });
        expect(await contextFor(projectId)).toBe("Old notes");
    });

    it("names no legacy file for a carried context, the list empty or not, and the next save clears it", async () => {
        const context = "Old notes";
        const fingerprinted = { carriedContext: contextFingerprint(context), updatedAt: 0, userId: OWNER, version: 1 };
        // The owner deleted the carried file and saved; a client that still writes `context` wrote the same text again.
        const emptied = await insert("projects", { context, createdAt: 0, title: "emptied", userId: OWNER });
        // The list holds the carried text as an ordinary file, after another one.
        const kept = await insert("projects", { context, createdAt: 0, title: "kept", userId: OWNER });
        const carriedFile = { content: context, id: "context", mode: "always" as const, title: "Project context" };

        await insert("projectRuleFiles", { ...fingerprinted, files: [], projectId: emptied });
        await insert("projectRuleFiles", { ...fingerprinted, files: [sqlRules, carriedFile], projectId: kept });

        const listedEmpty = await list(OWNER, emptied);

        expect(listedEmpty).toMatchObject({ canEdit: true, files: [] });
        expect(listedEmpty).not.toHaveProperty("legacyContextId");

        const listedKept = await list(OWNER, kept);

        expect(listedKept!.files.map((file) => file.id)).toStrictEqual(["sql", "context"]);
        expect(listedKept).not.toHaveProperty("legacyContextId");

        await save(OWNER, emptied, []);

        await expect(row(emptied)).resolves.toMatchObject({ context: "" });
        expect(await contextFor(emptied)).toBeNull();
    });

    it("keeps a context written after the save's check instead of clearing it unsaved", async () => {
        const projectId = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        const { files } = (await list(OWNER, projectId))!;
        const actual = await vi.importActual<typeof import("./rule-file-rows")>("./rule-file-rows");

        vi.mocked(writeProjectRuleFiles).mockImplementationOnce(async (ctx, ...rest) => {
            await actual.writeProjectRuleFiles(ctx, ...rest);
            await ctx.db.patch("projects", projectId as never, { context: "Newer notes" });
        });

        await save(OWNER, projectId, [sqlRules, ...files]);

        await expect(row(projectId)).resolves.toMatchObject({ context: "Newer notes" });
        expect((await list(OWNER, projectId))!.files.map((file) => file.id)).toStrictEqual(["context-2", "sql", "context"]);
    });

    it("clears the carried context with one guarded write: a title or a context written just before it stays", async () => {
        const titled = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        const rewritten = await insert("projects", { context: "Old notes", createdAt: 0, title: "p", userId: OWNER });
        // Another write lands right before the clear's own, after any read the clear made.
        const clearRacing = async (projectId: string, write: Record<string, unknown>) =>
            await harness.run(async (ctx: any) => {
                const raced = async <T>(apply: () => Promise<T>): Promise<T> => {
                    await ctx.db.patch("projects", projectId, write);

                    return await apply();
                };
                const db = new Proxy(ctx.db, {
                    get: (target, key) => {
                        const value = Reflect.get(target, key);

                        if (key === "patchIf" || key === "replace") {
                            return async (...args: unknown[]) => await raced(() => value.apply(target, args));
                        }

                        return typeof value === "function" ? value.bind(target) : value;
                    },
                });

                await markRuleFilesSaved(db, projectId as never, 5, { clearContext: "Old notes" });
            });

        await clearRacing(titled, { title: "Renamed" });
        await clearRacing(rewritten, { context: "Newer notes", title: "Renamed" });

        await expect(row(titled)).resolves.toMatchObject({ context: "", title: "Renamed", updatedAt: 5 });
        await expect(row(rewritten)).resolves.toMatchObject({ context: "Newer notes", title: "Renamed", updatedAt: 5 });
    });

    it("erases rule files a failed delete left: the sweep once the project is gone, and the owner's account", async () => {
        const sweep = async () => await harness.run(async (ctx: any) => await ctx.runMutation(sweepUnfinishedRuleFileErasures as never, {}));
        const markedLongAgo = async (projectId: string) =>
            await harness.run(async (ctx: any) => {
                const saved = await ctx.db.projectRuleFiles.findFirst({ where: { projectId } });

                await ctx.db.patch("projectRuleFiles", saved._id, { deletingAt: Date.now() - DELETION_MARKER_TTL_MS - 1 });
            });
        // A delete that marked the row and removed the project, then failed before its erase.
        const left = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "left", userId: OWNER });

        await harness.run(async (ctx: any) => {
            await markProjectRuleFilesErasing(ctx, left as never);
            await ctx.db.delete("projects", left);
        });
        // A delete that failed before the project row went: the project keeps its rules.
        const live = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "live", userId: OWNER });

        await sweep();
        // Not while a delete could still be running.
        await expect(savedFiles(left)).resolves.toStrictEqual([sqlRules]);

        await markedLongAgo(left);
        await markedLongAgo(live);
        await sweep();

        await expect(savedFiles(left)).resolves.toBeUndefined();
        await expect(savedFiles(live)).resolves.toStrictEqual([sqlRules]);
        await expect(ruleRow(live)).resolves.toMatchObject({ deletingAt: 0 });

        // Account deletion finds a row by its owner, its project gone; another user's stays.
        const orphan = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "orphan", userId: OWNER });
        const theirs = await project({ createdAt: 0, ruleFiles: [sqlRules], title: "theirs", userId: STRANGER });

        await harness.run(async (ctx: any) => await ctx.db.delete("projects", orphan));
        await harness.run(async (ctx: any) => await eraseProjectRuleFilesForUser(ctx, OWNER));

        await expect(savedFiles(orphan)).resolves.toBeUndefined();
        await expect(savedFiles(live)).resolves.toBeUndefined();
        await expect(savedFiles(theirs)).resolves.toStrictEqual([sqlRules]);
    });

    it("stamps a saved row with the project's owner", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });

        await save(OWNER, projectId, [sqlRules]);

        await expect(ruleRow(projectId)).resolves.toMatchObject({
            userId: OWNER,
            version: 1,
        });
    });

    it("refuses a pattern file without a pattern", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });

        await expect(save(OWNER, projectId, [{ ...sqlRules, globs: [] }])).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it.each([
        ["a name past its length", { ...sqlRules, title: "t".repeat(MAX_RULE_TITLE_LENGTH + 1) }, RULE_FILE_REFUSALS.TITLE_TOO_LONG],
        [
            "too many patterns",
            { ...sqlRules, globs: Array.from({ length: MAX_RULE_GLOBS + 1 }, (_, index) => `${index}.sql`) },
            RULE_FILE_REFUSALS.PATTERNS_TOO_MANY,
        ],
        ["a pattern past its length", { ...sqlRules, globs: ["p".repeat(MAX_RULE_GLOB_LENGTH + 1)] }, RULE_FILE_REFUSALS.PATTERN_INVALID],
    ])("refuses %s naming the file and the limit, past the argument check", async (_, file, code) => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });

        await expect(save(OWNER, projectId, [file])).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code, fileId: sqlRules.id } });
    });

    it("refuses a list past its stored size as a whole", async () => {
        const projectId = await insert("projects", { createdAt: 0, title: "p", userId: OWNER });
        const files = Array.from({ length: 6 }, (_, index) => {
            return { content: "\\".repeat(99_999), id: `f${index}`, mode: "always", title: `f${index}` };
        });

        await expect(save(OWNER, projectId, files)).rejects.toMatchObject({ code: "BAD_REQUEST", data: { code: RULE_FILE_REFUSALS.TOO_LARGE } });
    });
});

const LUNORA_DIR = resolve(import.meta.dirname, "..");
// A read or write of the table: `db.projectRuleFiles.…` or `("projectRuleFiles", …)`.
const TABLE_ACCESS = /projectRuleFiles(?:\s*\.|["'],)/u;

describe("the rule-file table's readers", () => {
    const sources = (directory: string, found: string[] = []): string[] => {
        const entries = readdirSync(directory, { withFileTypes: true });

        for (const entry of entries) {
            const full = join(directory, entry.name);

            if (entry.isDirectory() && entry.name !== "_generated" && entry.name !== "node_modules") {
                sources(full, found);
            } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
                found.push(full);
            }
        }

        return found;
    };

    it("are its storage helpers and the GDPR pass alone, so no other read pays for rule files", () => {
        const touching = sources(LUNORA_DIR)
            .filter((file) => TABLE_ACCESS.test(readFileSync(file, "utf8")))
            .map((file) => relative(LUNORA_DIR, file))
            .toSorted((left, right) => left.localeCompare(right));

        expect(touching).toStrictEqual(["projects/gdpr.ts", "projects/rule-file-rows.ts"]);
    });
});
