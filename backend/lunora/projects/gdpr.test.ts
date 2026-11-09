/**
 * The project repositories in the account export: read by owner a page at a time, every row of the user's, done only
 * after the last page, and never a row left out silently.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectAllRepositories } from "./export-pages";
import { collectProjectRepositoriesForExport } from "./gdpr";

const A = "user-a";
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

const exportFor = async (userId: string): Promise<{ pages: number; projectRepositories: unknown[] }> => {
    let pages = 0;
    const { projectRepositories } = await collectAllRepositories(async (cursor) => {
        pages += 1;

        return await harness.run((async (ctx: any) => await ctx.runQuery(collectProjectRepositoriesForExport, { cursor, userId })) as never);
    }, Infinity);

    return { pages, projectRepositories };
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

        expect(projectRepositories).toMatchObject([{ defaultBranch: "main", url: "https://github.com/o/r.git" }]);
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

        await expect(collectAllRepositories(async () => page(), 1000)).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    });
});
