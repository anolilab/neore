/**
 * Where an agent's pull request tools may run, through the real tables: only in a thread of the owner's own that nobody
 * else reads or steers. The rule is checked when a tool RUNS, so a tool that reached a group run another way (a group
 * skill's `additionalTools`) is refused there and reads nothing.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import type { ToolCtx } from "../agent/client/create-tool";
import { wrapTools } from "../agent/client/create-tool";
import { insertThread } from "../agent/table-writes";
import { readPullRequestTool } from "../chat/tools/pull-request";
import schema from "../schema";
import { linkedPullRequestsOfThread, pullRequestToolsAllowed } from "./pr-agent";

const { registry } = vi.hoisted(() => {
    return { registry: new Map<string, unknown>() };
});

// The tool reaches the internal queries by reference: resolve them to the registered procedures.
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

vi.mock("../connectors/lib/github-token", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../connectors/lib/github-token")>()),
        resolveGithubToken: async () => {
            return {
                accessToken: "owner-token",
                renew: async () => {
                    return { problem: "expired" };
                },
            };
        },
    };
});

const OWNER = "owner";

let harness: ReturnType<typeof lunoraTest>;

beforeAll(async () => {
    registerModule(registry, "source_control_pr_agent", await import("./pr-agent"));
});

beforeEach(() => {
    harness = lunoraTest(schema as never);
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ message: "no host call is expected" }, { status: 500 })),
    );
});

afterEach(() => {
    harness.close();
    vi.unstubAllGlobals();
});

const threadWith = async (extra: Record<string, unknown> = {}): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: OWNER,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: "a thread",
            updatedAt: Date.now(),
            userId: OWNER,
            ...extra,
        });

        await ctx.db.insert("pullRequestThreads", {
            createdAt: 1,
            kind: "linked",
            number: 7,
            repository: "octo/hello",
            threadId,
            title: "a thread",
            url: "https://github.com/octo/hello/pull/7",
            userId: OWNER,
        });

        return threadId as string;
    });

const GROUP = { groupChat: { mode: "round-robin", participants: [{ addedAt: 1, skillId: "skill-1" }] } };

const allowed = async (threadId: string): Promise<boolean> =>
    await harness.run(async (ctx: any) => await ctx.runQuery(pullRequestToolsAllowed as never, { threadId, userId: OWNER } as never));

const linked = async (threadId: string): Promise<unknown> =>
    await harness.run(async (ctx: any) => await ctx.runQuery(linkedPullRequestsOfThread as never, { threadId, userId: OWNER } as never));

describe("where the pull request tools may run", () => {
    it("allows the owner's own thread, and lists its links", async () => {
        const threadId = await threadWith();

        expect(await allowed(threadId)).toBe(true);
        expect(await linked(threadId)).toMatchObject({ complete: true, links: [{ number: 7, repository: "octo/hello" }] });
    });

    it("refuses a group thread, a public one and an outside chat, and shows none of their links", async () => {
        for (const extra of [GROUP, { isPublic: true }, { externalThreadId: "telegram:1" }]) {
            const threadId = await threadWith(extra);

            expect(await allowed(threadId)).toBe(false);
            expect(await linked(threadId)).toStrictEqual({ complete: true, links: [] });
        }
    });

    it("refuses a thread someone else was given access to", async () => {
        const threadId = await threadWith();

        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: "guest" }),
        );

        expect(await allowed(threadId)).toBe(false);
    });

    it("refuses another user's thread", async () => {
        const threadId = await threadWith();

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(pullRequestToolsAllowed as never, { threadId, userId: "someone" } as never))).toBe(
            false,
        );
    });
});

describe("a group run whose skill added readPullRequest", () => {
    const callTool = async (threadId: string, startedBy: string | undefined): Promise<unknown> =>
        await harness.run(async (ctx: any) => {
            const context = { ...ctx, startedBy, threadId, userId: OWNER } as unknown as ToolCtx;
            const read = wrapTools(context, { readPullRequest: readPullRequestTool }).readPullRequest!;

            return await (read.execute as (this: unknown, input: unknown, options: unknown) => Promise<unknown>).call(
                read,
                { number: 7, repository: "octo/hello" },
                { messages: [], toolCallId: "call-1" },
            );
        });

    it("is refused, and nothing is read from the host", async () => {
        const threadId = await threadWith(GROUP);
        const outcome = await callTool(threadId, OWNER);

        expect(outcome).toMatchObject({ status: "not_allowed" });
        expect(outcome).not.toHaveProperty("pullRequest");
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });

    it("is refused in a turn another person started, even in the owner's own thread", async () => {
        const threadId = await threadWith();
        const outcome = await callTool(threadId, "member");

        expect(outcome).toMatchObject({ status: "signed_out" });
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    });
});
