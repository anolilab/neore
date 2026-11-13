/**
 * The project repositories in the account export: read by owner a page at a time, every row of the user's, done only
 * after the last page, and never a row left out silently.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectAllRepositories } from "./export-pages";
import { collectProjectDetailsForExport, collectProjectRepositoriesForExport } from "./gdpr";

const A = "user-a";
const SHARE_TOKENS = /share-token|old-token/u;
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
