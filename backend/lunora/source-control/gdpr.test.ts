/**
 * Review drafts leave with the account and travel with the export: the user's own only,
 * and past one batch (130 > 100, and not a multiple of it, so "deleted one page" cannot
 * pass for "deleted everything").
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { collectAllGuides, collectAllReviewDrafts } from "./export-pages";
import { collectGuidesForExport, collectReviewDraftsForExport, deleteUserGuides, deleteUserReviewDrafts } from "./gdpr";

const A = "user-a";
const B = "user-b";
const MANY = 130;
const EXPORT_FILE_ARGS = /generateExportFile[\s\S]*reviewDrafts,/u;

let harness: ReturnType<typeof lunoraTest>;

const seed = async (userId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("reviewDrafts", {
                body: "text",
                comments: [{ body: "c", createdAt: 1, id: `c${String(index)}`, line: 2, path: "a.ts", side: "new", startLine: null }],
                commitId: "a".repeat(40),
                createdAt: 1,
                hostOrigin: "https://github.com",
                number: index + 1,
                repository: "o/r",
                revision: 1,
                submittingAt: 0,
                updatedAt: 1,
                userId,
                verdict: "comment",
            });
        }
    });
};

const countFor = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const found: { userId: string }[] = await ctx.db.query("reviewDrafts").collect();

        return found.filter((row) => row.userId === userId).length;
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("review drafts in GDPR flows", () => {
    it("deletes every draft of the user and nobody else's", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        let rounds = 0;

        for (; rounds < 100; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserReviewDrafts, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(rounds).toBeGreaterThan(0);
        expect(await countFor(A)).toBe(0);
        expect(await countFor(B)).toBe(1);
    });

    it("exports the user's drafts with their comments, and nobody else's", async () => {
        await seed(A, 2);
        await seed(B, 1);

        const exported = await harness.run(async (ctx: any) => await ctx.runQuery(collectReviewDraftsForExport, { userId: A }));

        expect(exported.drafts).toHaveLength(2);
        expect(exported.cursor).toBeNull();
        expect(exported.drafts[0].comments).toHaveLength(1);
        expect(JSON.stringify(exported)).not.toContain(B);
    });

    it("exports every draft page by page, past the size of one page", async () => {
        await seed(A, MANY);
        await seed(B, 1);

        let pages = 0;
        const { drafts } = await collectAllReviewDrafts(async (cursor) => {
            pages += 1;

            return await harness.run(async (ctx: any) => await ctx.runQuery(collectReviewDraftsForExport, { cursor, userId: A }));
        });

        expect(pages).toBeGreaterThan(1);
        expect(drafts).toHaveLength(MANY);
        expect(new Set(drafts.map((draft) => (draft as { number: number }).number)).size).toBe(MANY);
    });
});

describe("collectAllReviewDrafts", () => {
    it("treats a result recorded before paging existed as the only page", async () => {
        const seen: number[] = [];
        const { drafts } = await collectAllReviewDrafts(async (_cursor, page) => {
            seen.push(page);

            return { drafts: [{ number: 1 }] };
        });

        expect(seen).toEqual([0]);
        expect(drafts).toHaveLength(1);
    });
});

describe("review drafts in the account workflows", () => {
    // Read from source: the workflows need a Cloudflare Workflows runtime to run.
    const workflow = (name: string): string => readFileSync(join(import.meta.dirname, "../gdpr/workflows", name), "utf8");

    it("collects them for the export and hands them to the export file", () => {
        const source = workflow("export-workflow.ts");

        expect(source).toContain('"collect-review-drafts"');
        expect(source).toContain("internal.source_control.gdpr.collectReviewDraftsForExport");
        expect(source).toMatch(EXPORT_FILE_ARGS);
    });

    it("deletes them when the account is deleted", () => {
        const source = workflow("deletion-workflow.ts");

        expect(source).toContain('"delete-user-review-drafts"');
        expect(source).toContain("internal.source_control.gdpr.deleteUserReviewDrafts");
    });
});

const seedGuides = async (userId: string, count: number): Promise<void> => {
    await harness.run(async (ctx: any) => {
        for (let index = 0; index < count; index += 1) {
            await ctx.db.insert("pullRequestGuides", {
                createdAt: 1,
                generatedAt: 1,
                headSha: "a".repeat(40),
                hostOrigin: "https://github.com",
                instructions: "Look at errors",
                leftOut: 0,
                number: index + 1,
                proposals: [],
                repository: "o/r",
                source: "cloud",
                status: "ready",
                stops: [],
                summary: "Adds a thing.",
                updatedAt: 1,
                userId,
            });
        }
    });
};

const guidesFor = async (userId: string): Promise<number> =>
    await harness.run(async (ctx: any) => {
        const found: { userId: string }[] = await ctx.db.query("pullRequestGuides").collect();

        return found.filter((row) => row.userId === userId).length;
    });

describe("guides in GDPR flows", () => {
    it("deletes every guide of the user and nobody else's, past one batch", async () => {
        await seedGuides(A, MANY);
        await seedGuides(B, 1);

        let rounds = 0;

        for (; rounds < 100; rounds += 1) {
            const { hasMore } = await harness.run(async (ctx: any) => await ctx.runMutation(deleteUserGuides, { userId: A }));

            if (!hasMore) {
                break;
            }
        }

        expect(rounds).toBeGreaterThan(0);
        expect(await guidesFor(A)).toBe(0);
        expect(await guidesFor(B)).toBe(1);
    });

    it("exports every guide of the user page by page, and nobody else's", async () => {
        await seedGuides(A, 7);
        await seedGuides(B, 1);

        let pages = 0;
        const { guides } = await collectAllGuides(async (cursor) => {
            pages += 1;

            return await harness.run(async (ctx: any) => await ctx.runQuery(collectGuidesForExport, { cursor, userId: A }));
        });

        expect(pages).toBeGreaterThan(1);
        expect(guides).toHaveLength(7);
        expect(JSON.stringify(guides)).not.toContain(B);
    });
});
