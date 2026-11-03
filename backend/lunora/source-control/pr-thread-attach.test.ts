/**
 * Attaching existing pull requests to a thread by hand, through the real tables: the write refuses another user's
 * thread, names a pull request already linked instead of adding it twice, stops at the per-thread cap, and the
 * thread's list and the sidebar counts read the same rows.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { GITHUB_WEB_ORIGIN } from "./drivers/github";
import { countsForUser, listForThread, recordAttachedPullRequests } from "./pr-thread-attach";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: { id: "org-1" }, id: context.auth.userId, userId: context.auth.userId } : null,
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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

const A = "user-a";
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

const threadOf = async (owner: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: owner,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: "a thread",
            updatedAt: Date.now(),
            userId: owner,
        });

        return threadId as string;
    });

const link = (number: number, repo = "octo/hello") => {
    return { number, repository: repo, title: `PR ${String(number)}` };
};

const record = async (threadId: string, userId: string, links: ReturnType<typeof link>[]): Promise<any[]> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(recordAttachedPullRequests as never, { links, threadId, userId } as never));

describe("attaching a pull request to a thread by hand", () => {
    it("links it as attached, once: naming it again reports it already linked", async () => {
        const threadId = await threadOf(A);

        expect(await record(threadId, A, [link(7)])).toEqual([{ number: 7, repository: "octo/hello", status: "attached" }]);
        expect(await record(threadId, A, [link(7)])).toEqual([{ number: 7, repository: "octo/hello", status: "already_linked" }]);

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("pullRequestThreads").collect());

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: "attached",
            number: 7,
            repository: "octo/hello",
            title: "PR 7",
            url: `${GITHUB_WEB_ORIGIN}/octo/hello/pull/7`,
            userId: A,
        });
    });

    it("names the same pull request twice in one call as one link, because each copy sees the row before it", async () => {
        const threadId = await threadOf(A);

        expect(await record(threadId, A, [link(8), link(8)])).toEqual([
            { number: 8, repository: "octo/hello", status: "attached" },
            { number: 8, repository: "octo/hello", status: "already_linked" },
        ]);
    });

    it("refuses a thread that is not the caller's", async () => {
        const threadId = await threadOf(B);

        await expect(record(threadId, A, [link(7)])).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("stops at the per-thread cap and says so for the rest", async () => {
        const threadId = await threadOf(A);
        const twentyOne = Array.from({ length: 21 }, (_, index) => link(index + 1));
        const results = await record(threadId, A, twentyOne);

        expect(results.filter((result) => result.status === "attached")).toHaveLength(20);
        expect(results.at(-1)).toEqual({ number: 21, repository: "octo/hello", status: "thread_full" });
    });
});

describe("the thread list and the sidebar counts", () => {
    it("lists a thread's links newest first and counts only links whose thread is still there", async () => {
        const threadId = await threadOf(A);
        const otherId = await threadOf(A);

        await record(threadId, A, [link(7)]);
        // Two writes in one millisecond would tie on age, and the id breaks the tie at random: a gap makes the order real.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await record(threadId, A, [link(9, "octo/world")]);
        await record(otherId, A, [link(3)]);

        const listed = (await as(A).query(listForThread as never, { threadId } as never)) as any[];

        expect(listed.map((row: any) => `${row.repository}#${String(row.number)}`)).toEqual(["octo/world#9", "octo/hello#7"]);

        const counts = await as(A).query(countsForUser as never, {} as never);

        expect(counts).toEqual(
            expect.arrayContaining([
                { count: 2, threadId },
                { count: 1, threadId: otherId },
            ]),
        );
    });

    it("does not list one user's links to another user's thread", async () => {
        const threadId = await threadOf(A);

        await record(threadId, A, [link(7)]);

        expect(await as(B).query(listForThread as never, { threadId } as never)).toEqual([]);
    });
});
