/**
 * A status read stamps only the viewing chat's own link to that pull request: the header rotates its reads over those
 * links by this stamp, so another chat's row, another pull request or another account's row must not move.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import { recordPullRequestMerged, recordStatusRead } from "./pr-threads";

const OWNER = "user-owner";
const REPOSITORY = "octo/hello";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("recordStatusRead", () => {
    it("stamps only the viewing chat's link to that pull request", async () => {
        const ids = await harness.run(async (ctx: any) => {
            const viewing = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Viewing",
                updatedAt: Date.now(),
                userId: OWNER,
            });
            const other = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Other",
                updatedAt: Date.now(),
                userId: OWNER,
            });
            const link = async (threadId: unknown, number: number, userId: string) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 1,
                    kind: "attached",
                    number,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: `https://github.com/${REPOSITORY}/pull/${String(number)}`,
                    userId,
                });

            return {
                otherAccount: await link(viewing, 7, "other-user"),
                otherChat: await link(other, 7, OWNER),
                otherPullRequest: await link(viewing, 8, OWNER),
                viewed: await link(viewing, 7, OWNER),
            };
        });

        await harness.run(async (ctx: any) => {
            // The viewing chat is the one whose link is the `viewed` row above.
            const viewed = await ctx.db.get("pullRequestThreads", ids.viewed);

            await ctx.runMutation(recordStatusRead, { number: 7, repository: REPOSITORY, threadId: viewed?.threadId, userId: OWNER });
        });

        const rows = await harness.run(async (ctx: any) => {
            return {
                otherAccount: await ctx.db.get("pullRequestThreads", ids.otherAccount),
                otherChat: await ctx.db.get("pullRequestThreads", ids.otherChat),
                otherPullRequest: await ctx.db.get("pullRequestThreads", ids.otherPullRequest),
                viewed: await ctx.db.get("pullRequestThreads", ids.viewed),
            };
        });

        expect(rows.viewed?.statusReadAt).toBeTypeOf("number");
        expect(rows.otherChat?.statusReadAt).toBeUndefined();
        expect(rows.otherPullRequest?.statusReadAt).toBeUndefined();
        expect(rows.otherAccount?.statusReadAt).toBeUndefined();
    });

    it("does not stamp a link made after the host was asked, since that read did not include it", async () => {
        const ids = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Viewing",
                updatedAt: Date.now(),
                userId: OWNER,
            });
            const link = async (createdAt: number) =>
                await ctx.db.insert("pullRequestThreads", {
                    createdAt,
                    kind: "attached",
                    number: 7,
                    repository: REPOSITORY,
                    threadId,
                    title: "Feature work",
                    url: `https://github.com/${REPOSITORY}/pull/7`,
                    userId: OWNER,
                });

            return { after: await link(300), before: await link(100), threadId: String(threadId) };
        });

        await harness.run(async (ctx: any) => {
            // The host was asked at 200: the link made at 100 was part of that read, the one made at 300 was not.
            await ctx.runMutation(recordStatusRead, { number: 7, readStartedAt: 200, repository: REPOSITORY, threadId: ids.threadId, userId: OWNER });
        });

        const rows = await harness.run(async (ctx: any) => {
            return {
                after: await ctx.db.get("pullRequestThreads", ids.after),
                before: await ctx.db.get("pullRequestThreads", ids.before),
            };
        });

        expect(rows.before?.statusReadAt).toBeTypeOf("number");
        expect(rows.after?.statusReadAt).toBeUndefined();
    });
});

describe("recordPullRequestMerged", () => {
    it("stores the host's merge time on the link when a later read finds the merge", async () => {
        const HOST_MERGED_AT = 1000;
        const linkId = await harness.run(async (ctx: any) => {
            const threadId = await ctx.db.insert("threads", {
                mode: "text",
                model: "gpt-4o",
                status: "active",
                title: "Feature work",
                updatedAt: Date.now(),
                userId: OWNER,
            });

            return await ctx.db.insert("pullRequestThreads", {
                createdAt: 1,
                kind: "attached",
                number: 9,
                repository: REPOSITORY,
                threadId,
                title: "Feature work",
                url: `https://github.com/${REPOSITORY}/pull/9`,
                userId: OWNER,
            });
        });

        await harness.run(async (ctx: any) => {
            await ctx.runMutation(recordPullRequestMerged, { mergedAt: HOST_MERGED_AT, number: 9, repository: REPOSITORY, userId: OWNER });
        });

        const link = await harness.run(async (ctx: any) => await ctx.db.get("pullRequestThreads", linkId));

        expect(link?.mergedAt).toBe(HOST_MERGED_AT);
    });
});
