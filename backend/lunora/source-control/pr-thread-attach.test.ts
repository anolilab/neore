/**
 * Attaching existing pull requests to a thread by hand, through the real tables: the write refuses another user's
 * thread, names a pull request already linked instead of adding it twice, stops at the per-thread cap, and the
 * thread's list and the sidebar counts read the same rows.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { GITHUB_WEB_ORIGIN } from "./drivers/github";
import { attachPullRequests, countsForUser, listForThread, recordAttachedPullRequests } from "./pr-thread-attach";
import { setLinksThreadDeleted } from "./pr-thread-deleted";

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

const { host, registry } = vi.hoisted(() => {
    return {
        host: { outcome: { status: "not_found" } as Record<string, unknown>, reads: 0, renewals: 0, renewOnFirstRead: false, tokens: [] as string[] },
        registry: new Map<string, unknown>(),
    };
});

// The action reaches its own internal query by reference: resolve it to the registered procedure.
vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../connectors/lib/github-token", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../connectors/lib/github-token")>()),
        resolveGithubToken: async () => {
            const renewed = { accessToken: "renewed-token", renew: async () => renewed };

            return {
                accessToken: "test-token",
                renew: async () => {
                    host.renewals += 1;

                    return renewed;
                },
            };
        },
    };
});

vi.mock("./read-host", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("./read-host")>()),
        readFromHost: async (_driver: unknown, token: { accessToken: string; renew: () => Promise<unknown> }) => {
            host.reads += 1;
            host.tokens.push(token.accessToken);

            // The first read's token is refused once, as a host does with an expired one.
            if (host.renewOnFirstRead && host.reads === 1) {
                await token.renew();
            }

            return host.outcome;
        },
    };
});

const A = "user-a";
const B = "user-b";

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "source_control_pr_thread_attach", await import("./pr-thread-attach"));
});

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

const links = async (): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query("pullRequestThreads").collect());

const record = async (threadId: string, userId: string, rows: ReturnType<typeof link>[]): Promise<any[]> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(recordAttachedPullRequests as never, { links: rows, threadId, userId } as never));

describe("attaching a pull request to a thread by hand", () => {
    it("links it as attached, once: naming it again reports it already linked", async () => {
        const threadId = await threadOf(A);

        expect(await record(threadId, A, [link(7)])).toEqual([{ number: 7, repository: "octo/hello", status: "attached" }]);
        expect(await record(threadId, A, [link(7)])).toEqual([{ number: 7, repository: "octo/hello", status: "already_linked" }]);

        const rows = await harness.run(async (ctx: any) => await ctx.db.query("pullRequestThreads").collect());

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            kind: "linked",
            number: 7,
            repository: "octo/hello",
            title: "a thread",
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

describe("attaching by hand: the host read and the request limits", () => {
    const attach = (userId: string, threadId: string, pullRequests: { number: number; repository: string }[]): Promise<any> =>
        as(userId).action(attachPullRequests as never, { pullRequests, threadId } as never);

    it("writes no row for a pull request the host refuses, and reports the host's status for it", async () => {
        const threadId = await threadOf(A);

        host.outcome = { status: "not_found" };

        expect(await attach(A, threadId, [{ number: 7, repository: "octo/hello" }])).toEqual({
            results: [{ number: 7, repository: "octo/hello", status: "not_found" }],
        });
        expect(await links()).toEqual([]);
    });

    it("links a pull request the host returns, under the thread's title", async () => {
        const threadId = await threadOf(A);

        host.outcome = { baseBranch: "main", headBranch: "feature", status: "ok", title: "Host title" };

        expect(await attach(A, threadId, [{ number: 7, repository: "octo/hello" }])).toEqual({
            results: [{ number: 7, repository: "octo/hello", status: "attached" }],
        });
        expect(await links()).toEqual([expect.objectContaining({ headBranch: "feature", kind: "linked", title: "a thread" })]);
    });

    it("refuses more than ten pull requests in one call before any host read", async () => {
        const threadId = await threadOf(A);
        const eleven = Array.from({ length: 11 }, (_, index) => {
            return { number: index + 1, repository: "octo/hello" };
        });

        host.reads = 0;

        await expect(attach(A, threadId, eleven)).rejects.toThrow("Attach at most 10 pull requests at a time");
        expect(host.reads).toBe(0);
    });

    it("renews the token once for a batch: the reads after a renewal start from the new token", async () => {
        const threadId = await threadOf(A);

        Object.assign(host, { outcome: { status: "ok", title: "x" }, reads: 0, renewals: 0, renewOnFirstRead: true, tokens: [] });

        await attach(A, threadId, [
            { number: 1, repository: "octo/hello" },
            { number: 2, repository: "octo/hello" },
            { number: 3, repository: "octo/hello" },
        ]);

        expect(host.renewals).toBe(1);
        expect(host.tokens).toEqual(["test-token", "renewed-token", "renewed-token"]);

        host.renewOnFirstRead = false;
    });

    it("refuses another user's thread before any host read", async () => {
        const threadId = await threadOf(B);

        host.outcome = { status: "ok", title: "x" };

        await expect(attach(A, threadId, [{ number: 7, repository: "octo/hello" }])).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(await links()).toEqual([]);
    });
});

describe("the thread list and the sidebar counts", () => {
    it("lists a thread's links newest first and counts only links whose thread is still there", async () => {
        const threadId = await threadOf(A);
        const otherId = await threadOf(A);

        await record(threadId, A, [link(7)]);
        // Two writes in one millisecond would tie on age, and the id breaks the tie at random: a gap makes the order real.
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
        await record(threadId, A, [link(9, "octo/world")]);
        await record(otherId, A, [link(3)]);

        const listed = (await as(A).query(listForThread as never, { threadId } as never)) as any[];

        expect(listed.map((row: any) => `${row.repository}#${String(row.number)}`)).toEqual(["octo/world#9", "octo/hello#7"]);

        const counts = await as(A).query(countsForUser as never, {} as never);

        expect(counts).toEqual({
            counts: expect.arrayContaining([
                { count: 2, threadId },
                { count: 1, threadId: otherId },
            ]),
            truncated: false,
        });
    });

    it("does not count links whose thread is deleted", async () => {
        const threadId = await threadOf(A);
        const deletedId = await threadOf(A);

        await record(threadId, A, [link(7)]);
        await record(deletedId, A, [link(3)]);
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", deletedId, { deleted: true, deletedAt: 1 }));
        await harness.run(async (ctx: any) => await setLinksThreadDeleted(ctx, A, deletedId as never, true));

        expect(await as(A).query(countsForUser as never, {} as never)).toEqual({ counts: [{ count: 1, threadId }], truncated: false });
    });

    it("counts a restored thread's links again", async () => {
        const threadId = await threadOf(A);

        await record(threadId, A, [link(7)]);
        await harness.run(async (ctx: any) => await setLinksThreadDeleted(ctx, A, threadId as never, true));
        await harness.run(async (ctx: any) => await setLinksThreadDeleted(ctx, A, threadId as never, false));

        expect(await as(A).query(countsForUser as never, {} as never)).toEqual({ counts: [{ count: 1, threadId }], truncated: false });
    });

    it("does not list one user's links to another user's thread", async () => {
        const threadId = await threadOf(A);

        await record(threadId, A, [link(7)]);

        expect(await as(B).query(listForThread as never, { threadId } as never)).toEqual([]);
    });
});
