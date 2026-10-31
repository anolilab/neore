/**
 * The threads a pull request is worked on in go through the real procedures and
 * tables: starting attaches the PR to a fresh thread of yours (once), opened PRs
 * are recorded idempotently when the run reports them, and both kinds ride the
 * same list, newest first.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { addMessagesHandler } from "../agent/messages";
import { deleteAllForThreadIdAsync } from "../agent/threads";
import { insertThread } from "../agent/table-writes";

import schema from "../schema";
import { GITHUB_WEB_ORIGIN } from "./drivers/github";
import { getForThread, listForPullRequest, recordOpenedPullRequest, startWorkOnPullRequest } from "./pr-threads";

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
const PULL = { number: 7, repository: "octo/hello" };
const URL = `${GITHUB_WEB_ORIGIN}/octo/hello/pull/7`;

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const as = (userId: string) => harness.withIdentity({ userId });

const start = async (userId: string, overrides: Record<string, unknown> = {}): Promise<any> =>
    await as(userId).mutation(startWorkOnPullRequest as never, { ...PULL, ...overrides } as never);

const listing = async (userId: string, overrides: Record<string, unknown> = {}): Promise<any[]> =>
    await as(userId).query(listForPullRequest as never, { ...PULL, ...overrides } as never);

/** A plain thread that no pull request was ever attached to. */
const plainThread = async (owner: string): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: owner,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: "plain",
            updatedAt: Date.now(),
            userId: owner,
        });

        await addMessagesHandler(ctx, { fromUser: true, messages: [{ message: { content: "hi", role: "user" }, status: "success" }], threadId, userId: owner });

        return threadId as string;
    });

const links = async (): Promise<any[]> => await harness.run(async (ctx: any) => await ctx.db.query("pullRequestThreads").collect());

const messagesOf = async (threadId: string): Promise<any[]> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                .collect(),
    );

describe("starting work on a pull request", () => {
    it("opens a thread of yours with the pull request attached for the first turn", async () => {
        const result = await start(A);

        expect(result).toMatchObject({ created: true });
        expect(typeof result.threadId).toBe("string");

        const [row] = await links();

        expect(row).toMatchObject({ ...PULL, kind: "attached", threadId: result.threadId, title: "Work on octo/hello#7", url: URL });

        const thread = await harness.run(async (ctx: any) => await ctx.db.get(result.threadId));

        expect(thread).toMatchObject({ status: "active", title: "Work on octo/hello#7" });
        expect(thread.model).toBeUndefined();
        expect(thread.tags).toContain("develop");

        const messages = await messagesOf(result.threadId);

        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({ userId: A });
        expect(messages[0].message).toMatchObject({ content: expect.stringContaining(URL), role: "user" });
    });

    it("attaches the next turn to the same thread, once", async () => {
        const first = await start(A);
        const second = await start(A);

        expect(second).toEqual({ created: false, threadId: first.threadId });
        expect(await messagesOf(first.threadId)).toHaveLength(1);
        expect(await links()).toHaveLength(1);
    });

    it("keeps everyone's work to themselves: B starts on their own thread", async () => {
        const a = await start(A);
        const b = await start(B);

        expect(b.threadId).not.toBe(a.threadId);
        expect(await listing(B)).toEqual([expect.objectContaining({ kind: "attached", threadId: b.threadId })]);
        expect(await listing(A)).toEqual([expect.objectContaining({ kind: "attached", threadId: a.threadId })]);
    });

    it.each([
        ["an address that is not owner/name", { ...PULL, repository: "gitlab:octo/hello" }],
        ["a number below 1", { number: 0, repository: PULL.repository }],
        ["a branch cannot safely name one", { headBranch: "a..b", ...PULL }],
    ])("refuses %j", async (_label, args) => {
        await expect(start(A, args)).rejects.toBeDefined();
        expect(await links()).toHaveLength(0);
    });
});

describe("a PR the coding agent opened is recorded", () => {
    const record = async (userId: string, threadId: string): Promise<any> =>
        await harness.run(async (ctx: any) => await ctx.runMutation(recordOpenedPullRequest as never, { prUrl: URL, threadId, userId } as never));

    it("parses the page against this host and links it to the run's thread, once", async () => {
        const threadId = (await plainThread(A)) as string;

        await record(A, threadId);
        await record(A, threadId);

        const [row] = await links();

        expect(row).toMatchObject({ ...PULL, kind: "opened", threadId, url: URL });
        expect(await links()).toHaveLength(1);

        const seen = await listing(A);

        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ kind: "opened", threadId });
    });

    it("names another user when the thread is someone else's, and nothing is recorded for a thread that is not there", async () => {
        const theirs = (await plainThread(A)) as string;

        await expect(record(B, theirs)).rejects.toMatchObject({ status: 403 });
        await expect(record(A, "j58abc123def")).rejects.toBeDefined();
        expect(await links()).toHaveLength(0);
    });

    it("refuses a page the service did not generate, and a pull request number that does not parse", async () => {
        const threadId = (await plainThread(A)) as string;
        const recordPage = async (prUrl: string) =>
            await harness.run(async (ctx: any) => await ctx.runMutation(recordOpenedPullRequest as never, { prUrl, threadId, userId: A } as never));

        await expect(recordPage("https://gitlab.com/octo/hello/pull/7")).rejects.toBeDefined();
        await expect(recordPage(`${GITHUB_WEB_ORIGIN}/octo/hello/pull/oops`)).rejects.toBeDefined();
        await expect(recordPage("not a url at all")).rejects.toBeDefined();
        expect(await links()).toHaveLength(0);
    });
});

describe("both sides of the link", () => {
    it("lists every kind for the pull request, newest first", async () => {
        const attached = await start(A);
        const threadId = (await plainThread(A)) as string;

        await harness.run(async (ctx: any) => await ctx.runMutation(recordOpenedPullRequest as never, { prUrl: URL, threadId, userId: A } as never));

        const rows = await listing(A);

        expect(rows).toHaveLength(2);
        expect(rows[0].kind).toBe("opened");
        expect(rows[1]).toMatchObject({ kind: "attached", threadId: attached.threadId });

        const otherRepo = await listing(A, { number: 8 });

        expect(otherRepo).toEqual([]);
    });

    it("a thread reads the pull request it was attached to, and one without is told so", async () => {
        const { threadId } = await start(A);

        expect(await as(A).query(getForThread as never, { threadId } as never)).toMatchObject({ kind: "attached", url: URL });

        const plain = (await plainThread(A)) as string;

        expect(await as(A).query(getForThread as never, { threadId: plain } as never)).toBeNull();
    });

    it("the pull request is only on your list: another user reads neither", async () => {
        const { threadId } = await start(A);

        expect(await as(B).query(getForThread as never, { threadId } as never)).toBeNull();
        expect(await listing(B)).toEqual([]);
    });
});

describe("a thread that is gone", () => {
    const softDelete = async (threadId: string): Promise<void> => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { deleted: true, deletedAt: 1 }));
    };

    it("is not returned by another click on 'Work on this PR': the dead link is cleared and a new thread opens", async () => {
        const first = await start(A);

        await softDelete(first.threadId);

        const second = await start(A);

        expect(second.created).toBe(true);
        expect(second.threadId).not.toBe(first.threadId);
        expect(await links()).toEqual([expect.objectContaining({ kind: "attached", threadId: second.threadId })]);
    });

    it("is not listed, and a thread that is gone names no pull request", async () => {
        const first = await start(A);
        const other = (await plainThread(A)) as string;

        await harness.run(async (ctx: any) => await ctx.runMutation(recordOpenedPullRequest as never, { prUrl: URL, threadId: other, userId: A } as never));
        await softDelete(first.threadId);

        expect(await listing(A)).toEqual([expect.objectContaining({ kind: "opened", threadId: other })]);
        expect(await as(A).query(getForThread as never, { threadId: first.threadId } as never)).toBeNull();
    });

    it("loses its links with a hard delete, attached and opened alike", async () => {
        const first = await start(A);
        const other = (await plainThread(A)) as string;

        await harness.run(async (ctx: any) => await ctx.runMutation(recordOpenedPullRequest as never, { prUrl: URL, threadId: other, userId: A } as never));
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync as never, { threadId: first.threadId } as never));
        await harness.run(async (ctx: any) => await ctx.runMutation(deleteAllForThreadIdAsync as never, { threadId: other } as never));

        expect(await links()).toEqual([]);
    });
});

describe("a thread with two links", () => {
    it("names the newest pull request", async () => {
        const first = await start(A);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("pullRequestThreads", {
                createdAt: Date.now() + 10_000,
                kind: "opened",
                number: 9,
                repository: "octo/hello",
                threadId: first.threadId,
                title: "x",
                url: `${GITHUB_WEB_ORIGIN}/octo/hello/pull/9`,
                userId: A,
            });
        });

        expect(await as(A).query(getForThread as never, { threadId: first.threadId } as never)).toMatchObject({ kind: "opened", number: 9 });
    });
});

describe("the repository's casing", () => {
    it("names one pull request however it is spelled", async () => {
        const first = await start(A);
        const second = await start(A, { repository: "Octo/Hello" });

        expect(second).toEqual({ created: false, threadId: first.threadId });
        expect(await listing(A, { repository: "OCTO/hello" })).toHaveLength(1);
        const [row] = await links();

        expect(row.repository).toBe("octo/hello");
    });
});
