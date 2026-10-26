/**
 * Deleting a thread drops the share routes its publication left in
 * `shardRoutes`; only the share toggle removed them before.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

import schema from "../schema";
import { deleteThread, deleteThreads } from "./functions";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

beforeAll(async () => {
    registerModule(registry, "chat_functions", await import("./functions"));
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId
                ? {
                      activeOrganization: null,
                      email: `${context.auth.userId}@example.com`,
                      id: context.auth.userId,
                      isAdmin: false,
                      name: context.auth.userId,
                      userId: context.auth.userId,
                  }
                : null,
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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const OWNER = "owner";
const STRANGER = "stranger";

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);

/** A thread published under `token`, with the two routes the share toggle writes. */
const publicThread = async (token: string, userId = OWNER): Promise<string> =>
    await harness.run(async (ctx: any) => {
        const threadId = (await ctx.db.insert("threads", { isPublic: true, publicAccessToken: token, status: "active", title: "T", userId })) as string;

        await ctx.db.insert("shardRoutes", { createdAt: Date.now(), key: `thread-public:${token}`, ownerId: userId });
        await ctx.db.insert("shardRoutes", { createdAt: Date.now(), key: `thread-share:${threadId}`, ownerId: userId });

        return threadId;
    });

const routeKeys = async (): Promise<string[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.shardRoutes.findMany({});

        return (page as { key: string }[]).map((row) => row.key).toSorted((a, b) => a.localeCompare(b));
    });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("share routes of a deleted thread", () => {
    it("deleteThread removes the thread-public and thread-share routes", async () => {
        const threadId = await publicThread("tok-1");
        const other = await publicThread("tok-2");

        await as(OWNER).mutation(deleteThread as never, { threadId } as never);

        await expect(routeKeys()).resolves.toEqual([`thread-public:tok-2`, `thread-share:${other}`]);
    });

    it("deleteThreads removes the routes of the threads that went, and keeps a stranger's", async () => {
        const mine = await publicThread("tok-1");
        const theirs = await publicThread("tok-2", STRANGER);

        await expect(as(OWNER).mutation(deleteThreads as never, { threadIds: [mine, theirs] } as never)).resolves.toMatchObject({ deletedCount: 1 });

        await expect(routeKeys()).resolves.toEqual([`thread-public:tok-2`, `thread-share:${theirs}`]);
    });

    it("deleting a thread that was never public touches no route", async () => {
        const threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }));

        await as(OWNER).mutation(deleteThread as never, { threadId } as never);

        await expect(routeKeys()).resolves.toEqual([]);
    });
});
