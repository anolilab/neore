/**
 * The project repositories in the account export: read by owner a page at a time, every row of the user's, done only
 * after the last page, and never a row left out silently.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { attachProjectRuleFiles, collectAllOwnedProjects, collectAllRepositories } from "./export-pages";
import { contextFingerprint } from "./rule-files";
import { collectOwnedProjectsForExport, collectProjectDetailsForExport, collectProjectRepositoriesForExport, collectProjectRuleFilesForExport } from "./gdpr";

const A = "user-a";
const SHARE_TOKENS = /share-token|old-token/u;
const PROJECT_FOLDER = /^\/home\/a\/p\d$/u;
const PROJECT_TITLE = /^p\d$/u;
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

const exportFor = async (
    userId: string,
    maxBytes = Infinity,
    detailsMaxBytes = maxBytes,
): Promise<{ detailReads: number; pages: number; projectRepositories: unknown[] }> => {
    let pages = 0;
    let detailReads = 0;
    const { projectRepositories } = await collectAllRepositories(
        async (cursor) => {
            pages += 1;

            return await harness.run((async (ctx: any) => await ctx.runQuery(collectProjectRepositoriesForExport, { cursor, userId })) as never);
        },
        async (projectIds) => {
            detailReads += 1;

            return await harness.run((async (ctx: any) => await ctx.runQuery(collectProjectDetailsForExport, { projectIds, userId })) as never);
        },
        maxBytes,
        detailsMaxBytes,
    );

    return { detailReads, pages, projectRepositories };
};

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

describe("project repositories in the GDPR export", () => {
    it("exports the user's rows by owner, one whose project is gone too, never a delete's marker or another user's", async () => {
        await harness.run((async (ctx: any) => {
            const gone = await ctx.db.insert("projects", { createdAt: 1, title: "gone", userId: A });

            await ctx.db.delete("projects", gone);
            await ctx.db.insert("projectRepositories", { createdAt: 1, defaultBranch: "main", projectId: gone, url: "https://github.com/o/r.git", userId: A });
            await ctx.db.insert("projectRepositories", { createdAt: 1, deletingAt: 1, projectId: gone, url: "", userId: A });
            await ctx.db.insert("projectRepositories", { createdAt: 1, projectId: gone, url: "https://github.com/o/b.git", userId: B });
        }) as never);

        const { projectRepositories } = await exportFor(A);

        expect(projectRepositories).toMatchObject([{ defaultBranch: "main", project: null, url: "https://github.com/o/r.git" }]);
    });

    it("puts each repository's project details next to it: the title and whether sharing is on, never the share token", async () => {
        await harness.run((async (ctx: any) => {
            const projectId = await ctx.db.insert("projects", { createdAt: 1, isPublic: true, publicAccessToken: "share-token", title: "Web", userId: A });
            // Unpublished: the token stays for a later re-publish, but the project is not shared.
            const unpublished = await ctx.db.insert("projects", { createdAt: 1, isPublic: false, publicAccessToken: "old-token", title: "Draft", userId: A });

            await ctx.db.insert("projectRepositories", { createdAt: 1, projectId, url: "https://github.com/o/web.git", userId: A });
            await ctx.db.insert("projectRepositories", { createdAt: 2, projectId, url: "https://github.com/o/api.git", userId: A });
            await ctx.db.insert("projectRepositories", { createdAt: 3, projectId: unpublished, url: "https://github.com/o/draft.git", userId: A });
        }) as never);

        const { projectRepositories } = await exportFor(A);
        const byUrl = (projectRepositories as { url: string }[]).toSorted((left, right) => left.url.localeCompare(right.url));

        expect(byUrl).toMatchObject([
            { project: { sharingEnabled: true, title: "Web" }, url: "https://github.com/o/api.git" },
            { project: { sharingEnabled: false, title: "Draft" }, url: "https://github.com/o/draft.git" },
            { project: { sharingEnabled: true, title: "Web" }, url: "https://github.com/o/web.git" },
        ]);
        expect(JSON.stringify(projectRepositories)).not.toMatch(SHARE_TOKENS);
    });

    it("reads projects two to a query, and marks the details left out once the reads pass the budget", async () => {
        await harness.run((async (ctx: any) => {
            for (const title of ["One", "Two", "Three", "Four", "Five", "Six"]) {
                const projectId = await ctx.db.insert("projects", { context: "x".repeat(5000), createdAt: 1, title, userId: A });

                await ctx.db.insert("projectRepositories", { createdAt: 1, projectId, url: `https://github.com/o/${title}.git`, userId: A });
            }
        }) as never);

        const all = await exportFor(A);

        expect(all.detailReads).toBe(3);
        expect(all.projectRepositories.filter((row) => "title" in (row as { project: object }).project)).toHaveLength(6);

        // Room for the rows and the first read of two projects (about 10 KB), which uses up the rest: the other four are
        // not read, and every repository is still exported.
        const capped = await exportFor(A, 3000);

        expect(capped.detailReads).toBe(1);
        expect(capped.projectRepositories).toHaveLength(6);
        expect(capped.projectRepositories.filter((row) => "title" in (row as { project: object }).project)).toHaveLength(2);
        expect(capped.projectRepositories.filter((row) => "detailsOmitted" in (row as { project: object }).project)).toHaveLength(4);
    });

    it("still exports every repository when earlier sections left the details nothing, reading no project", async () => {
        await harness.run((async (ctx: any) => {
            const projectId = await ctx.db.insert("projects", { createdAt: 1, title: "Web", userId: A });

            await ctx.db.insert("projectRepositories", { createdAt: 1, projectId, url: "https://github.com/o/web.git", userId: A });
        }) as never);

        // The rows keep their floor; the details' budget is spent before the first read.
        const { detailReads, projectRepositories } = await exportFor(A, Infinity, 0);

        expect(detailReads).toBe(0);
        expect(projectRepositories).toMatchObject([{ project: { detailsOmitted: true }, url: "https://github.com/o/web.git" }]);
    });

    it("pages past one page (230 rows over 3 pages of 100) and reports done only after the last", async () => {
        await harness.run((async (ctx: any) => {
            const projectId = await ctx.db.insert("projects", { createdAt: 1, title: "many", userId: A });

            for (let index = 0; index < 230; index += 1) {
                await ctx.db.insert("projectRepositories", { createdAt: index, projectId, url: `https://github.com/o/r${String(index)}.git`, userId: A });
            }
        }) as never);

        const { pages, projectRepositories } = await exportFor(A);

        expect(pages).toBe(3);
        expect(new Set(projectRepositories.map((row) => (row as { url: string }).url)).size).toBe(230);
    });

    it("fails with PAYLOAD_TOO_LARGE once the pages outgrow the limit, rather than return a cut list", async () => {
        const page = () => {
            return { cursor: "next", projectRepositories: [{ url: "x".repeat(500) }] };
        };

        await expect(
            collectAllRepositories(
                async () => page(),
                async () => {
                    return { projects: [], readBytes: 0 };
                },
                1000,
            ),
        ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });
});

describe("owned projects in the GDPR export", () => {
    const ownedFor = async (userId: string, maxBytes = Infinity) => {
        let pages = 0;
        const result = await collectAllOwnedProjects(async (cursor) => {
            pages += 1;

            return await harness.run((async (ctx: any) => await ctx.runQuery(collectOwnedProjectsForExport, { cursor, userId })) as never);
        }, maxBytes);

        return { ...result, pages };
    };

    it("exports every project the user owns, with or without a repository, its machine and folder, and never another user's", async () => {
        await harness.run((async (ctx: any) => {
            await ctx.db.insert("projects", { createdAt: 1, path: "/home/a/app", title: "with folder", userId: A });
            await ctx.db.insert("projects", { createdAt: 2, subAgentRoles: { review: { model: "m" } }, title: "no folder", userId: A });
            await ctx.db.insert("projects", { createdAt: 3, title: "not mine", userId: B });
        }) as never);

        const { projects } = await ownedFor(A);

        // Rows created in the same millisecond share a _creationTime, so the order between them is not asserted.
        expect(projects).toHaveLength(2);
        expect(projects).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ path: "/home/a/app", sharingEnabled: false, title: "with folder" }),
                expect.objectContaining({ sharingEnabled: false, subAgentRoles: { review: { model: "m" } }, title: "no folder" }),
            ]),
        );
    });

    it("pages two projects to a query and reports the rows' read cost, the rows counted whole", async () => {
        await harness.run((async (ctx: any) => {
            for (let index = 0; index < 5; index += 1) {
                await ctx.db.insert("projects", { createdAt: index, title: `p${index}`, userId: A });
            }
        }) as never);

        const { pages, projects, readBytes } = await ownedFor(A);

        expect(projects).toHaveLength(5);
        expect(pages).toBe(3);
        expect(readBytes).toBeGreaterThan(0);
    });

    it("exports every project past the read limit, marked detailsOmitted, with its id, title, machine and folder", async () => {
        await harness.run((async (ctx: any) => {
            for (let index = 0; index < 5; index += 1) {
                await ctx.db.insert("projects", { createdAt: index, isPublic: true, path: `/home/a/p${index}`, title: `p${index}`, userId: A });
            }
        }) as never);

        const { projects } = await ownedFor(A, 16);

        expect(projects).toHaveLength(5);

        for (const project of projects) {
            expect(project).toMatchObject({
                detailsOmitted: true,
                path: expect.stringMatching(PROJECT_FOLDER),
                projectId: expect.any(String),
                title: expect.stringMatching(PROJECT_TITLE),
            });
            expect(project).not.toHaveProperty("sharingEnabled");
        }
    });

    it("counts a project's whole row, its heavy columns too, as the read is charged, and past the budget marks the rest", async () => {
        await harness.run((async (ctx: any) => {
            // Every row large, so whichever page a row lands on (rows inserted together can share a _creationTime), it passes the budget.
            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("projects", { context: "x".repeat(100_000), createdAt: index, title: `p${index}`, userId: A });
            }
        }) as never);

        const { projects, readBytes } = await ownedFor(A, 4096);

        expect(readBytes).toBeGreaterThan(300_000);
        expect(projects).toHaveLength(3);
        // Every project is still exported, each marked.
        expect(projects).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ detailsOmitted: true })));
        expect(projects.map((project) => (project as { context?: unknown }).context)).toEqual([undefined, undefined, undefined]);
    });
});

describe("project rule files in the GDPR export", () => {
    const sql = { content: "Use snake_case.", globs: ["**/*.sql"], id: "sql", mode: "glob", title: "SQL" };
    /** As the export runs it: the owned projects' pages, then their rule files within `maxBytes`, counting each read. */
    const withRules = async (maxBytes = Infinity, contextMaxBytes = Infinity, betweenReads?: () => Promise<void>) => {
        const reads: string[] = [];
        const harnessRead = async (query: string, run: (ctx: any) => Promise<unknown>) => {
            reads.push(query);

            return await harness.run(run as never);
        };
        const owned = await collectAllOwnedProjects(
            async (cursor) => await harnessRead("owned", async (ctx) => await ctx.runQuery(collectOwnedProjectsForExport, { cursor, userId: A })),
            Infinity,
        );

        await betweenReads?.();

        const result = await attachProjectRuleFiles(
            owned.projects as object[],
            owned.contexts,
            async (projectIds) =>
                (await harnessRead("ruleFiles", async (ctx) => await ctx.runQuery(collectProjectRuleFilesForExport, { projectIds, userId: A }))) as never,
            maxBytes,
            contextMaxBytes,
        );

        return { ...result, reads };
    };
    const byTitle = (projects: object[]) => new Map(projects.map((project) => [(project as { title: string }).title, project]));

    it("exports each of the user's projects' rule files, a legacy context first, never another user's", async () => {
        await harness.run((async (ctx: any) => {
            const ids = [
                await ctx.db.insert("projects", { context: "Answer briefly.", createdAt: 1, title: "rules", userId: A }),
                await ctx.db.insert("projects", { createdAt: 2, title: "plain", userId: A }),
                await ctx.db.insert("projects", { context: "Only context.", createdAt: 3, title: "context only", userId: A }),
                await ctx.db.insert("projects", { context: "secret", createdAt: 4, title: "theirs", userId: B }),
            ];

            await ctx.db.insert("projectRuleFiles", { files: [sql], projectId: ids[0], updatedAt: 0, userId: A });
            await ctx.db.insert("projectRuleFiles", { files: [sql], projectId: ids[3], updatedAt: 0, userId: B });
        }) as never);

        const { projects: exported } = await withRules();
        const projects = byTitle(exported);

        expect(projects.size).toBe(3);
        expect(projects.get("rules")).toMatchObject({
            ruleFiles: [{ content: "Answer briefly.", id: "context", mode: "always", title: "Project context" }, sql],
        });
        expect(projects.get("plain")).not.toHaveProperty("ruleFiles");
        expect(projects.get("context only")).toMatchObject({ ruleFiles: [{ content: "Only context.", id: "context" }] });

        for (const project of projects.values()) {
            expect(project).not.toHaveProperty("context");
        }
    });

    it("reads no rule files of a project that changed owner after the projects' page was read", async () => {
        const moved = (await harness.run((async (ctx: any) => {
            const projectId = await ctx.db.insert("projects", { createdAt: 1, title: "moved", userId: A });

            await ctx.db.insert("projectRuleFiles", { files: [sql], projectId, updatedAt: 0, userId: A });

            return projectId;
        }) as never)) as string;

        const { projects: exported } = await withRules(Infinity, Infinity, async () => {
            // An account merge or an organization move, between the two reads; the rule-file row keeps its old `userId`.
            await harness.run((async (ctx: any) => {
                await ctx.db.patch("projects", moved, { userId: B });
                const row = await ctx.db.projectRuleFiles.findFirst({ where: { projectId: moved } });

                await ctx.db.patch("projectRuleFiles", row._id, { files: [{ ...sql, content: "B's rules." }] });
            }) as never);
        });

        expect(byTitle(exported).get("moved")).not.toHaveProperty("ruleFiles");
        expect(JSON.stringify(exported)).not.toContain("B's rules.");
    });

    it("leaves a context the saved list carries already out, so it is exported once", async () => {
        await harness.run((async (ctx: any) => {
            const projectId = await ctx.db.insert("projects", { context: "Carried.", createdAt: 1, title: "carried", userId: A });
            const carried = { content: "Carried.", id: "context", mode: "always", title: "Project context" };

            await ctx.db.insert("projectRuleFiles", { carriedContext: contextFingerprint("Carried."), files: [carried], projectId, updatedAt: 0, userId: A });
        }) as never);

        const { projects } = await withRules();

        expect(projects).toMatchObject([{ ruleFiles: [{ content: "Carried." }] }]);
        expect((projects[0] as { ruleFiles: unknown[] }).ruleFiles).toHaveLength(1);
    });

    it("marks the projects whose rule files it no longer reads past the budget, and keeps them in the export", async () => {
        await harness.run((async (ctx: any) => {
            for (let index = 0; index < 3; index += 1) {
                const projectId = await ctx.db.insert("projects", { createdAt: index, title: `p${index}`, userId: A });

                await ctx.db.insert("projectRuleFiles", { files: [{ ...sql, content: "x".repeat(1000) }], projectId, updatedAt: 0, userId: A });
            }
        }) as never);

        const { projects } = await withRules(100);

        expect(projects).toHaveLength(3);
        // One to a read: the first read passes the budget, so the other two projects' files are not read.
        expect(projects.filter((project) => "ruleFiles" in project)).toHaveLength(1);
        expect(projects.filter((project) => "ruleFilesOmitted" in project)).toEqual([
            expect.objectContaining({ ruleFilesOmitted: true }),
            expect.objectContaining({ ruleFilesOmitted: true }),
        ]);
    });

    it("still exports a legacy context past the budget: it was read with the project's page, so it costs no read", async () => {
        await harness.run((async (ctx: any) => {
            for (let index = 0; index < 3; index += 1) {
                const projectId = await ctx.db.insert("projects", { context: `Context ${String(index)}.`, createdAt: index, title: `p${index}`, userId: A });

                await ctx.db.insert("projectRuleFiles", { files: [{ ...sql, content: "x".repeat(1000) }], projectId, updatedAt: 0, userId: A });
            }
        }) as never);

        const { projects } = await withRules(100);
        const omitted = projects.filter((project) => "ruleFilesOmitted" in project);

        expect(omitted).toHaveLength(2);

        // The saved list was not read, the context still is exported, and the project says the rest was left out.
        for (const project of omitted) {
            const { title } = project as { title?: string };

            expect(project).toMatchObject({ ruleFiles: [{ content: `Context ${(title ?? "").slice(1)}.`, id: "context" }], ruleFilesOmitted: true });
        }
    });

    it("leaves out a legacy context past the export's share for them, marked, and keeps the project's saved files", async () => {
        await harness.run((async (ctx: any) => {
            // Carried into the list already (a clear that failed): exported once, from the list, and not counted.
            const carried = await ctx.db.insert("projects", { context: "k".repeat(1000), createdAt: 0, title: "carried", userId: A });
            const carriedFile = { content: "k".repeat(1000), id: "context", mode: "always", title: "Project context" };

            await ctx.db.insert("projectRuleFiles", {
                carriedContext: contextFingerprint("k".repeat(1000)),
                files: [carriedFile],
                projectId: carried,
                updatedAt: 0,
                userId: A,
            });

            for (let index = 1; index <= 3; index += 1) {
                const projectId = await ctx.db.insert("projects", { context: "c".repeat(1000), createdAt: index, title: `p${index}`, userId: A });

                await ctx.db.insert("projectRuleFiles", { files: [sql], projectId, updatedAt: 0, userId: A });
            }
        }) as never);

        // Room for two of the three contexts not carried (each about 1 KB as JSON).
        const { projects } = await withRules(Infinity, 2500);
        const byName = byTitle(projects);
        const omitted = projects.filter((project) => "ruleFilesOmitted" in project);

        expect(projects).toHaveLength(4);
        expect(byName.get("carried")).not.toHaveProperty("ruleFilesOmitted");
        expect((byName.get("carried") as { ruleFiles: unknown[] }).ruleFiles).toHaveLength(1);
        // Every other project keeps its saved files; only one goes without its context, and says so.
        expect(omitted).toMatchObject([{ ruleFiles: [sql], ruleFilesOmitted: true }]);
        expect(projects.filter((project) => (project as { ruleFiles: { content: string }[] }).ruleFiles[0]?.content === "c".repeat(1000))).toHaveLength(2);
    });

    it("counts the project rows it reads again for the owner check, and still exports every legacy context", async () => {
        const workflowContent = { edges: [], nodes: [{ data: { text: "w".repeat(50_000) }, id: "n", position: { x: 0, y: 0 }, type: "note" }] };

        await harness.run((async (ctx: any) => {
            for (let index = 0; index < 3; index += 1) {
                await ctx.db.insert("projects", { context: "Be brief.", createdAt: index, title: `p${index}`, userId: A, workflowContent });
            }
        }) as never);

        const { projects, readBytes, reads } = await withRules(1000);

        // The first project row, read whole again, passes the budget: the others' saved files are not read.
        expect(readBytes).toBeGreaterThan(50_000);
        expect(reads).toStrictEqual(["owned", "owned", "ruleFiles"]);
        expect(projects).toEqual(Array.from({ length: 3 }, () => expect.objectContaining({ ruleFiles: [expect.objectContaining({ content: "Be brief." })] })));
        expect(projects.filter((project) => "ruleFilesOmitted" in project)).toHaveLength(2);
    });
});
