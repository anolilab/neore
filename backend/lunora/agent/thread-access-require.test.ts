/**
 * The `require*` thread-access helpers: every client-reachable procedure that
 * takes a thread id from its args authorizes through one of them, and all of
 * them fail with the same NOT_FOUND, whether the thread is missing or merely
 * someone else's — so the error is no oracle for which thread ids exist.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import schema from "../schema";
import type { ThreadPermission } from "./thread-read-access";
import { requireOwnedThread, requireThreadPermission, requireThreadPermissionInAction } from "./thread-read-access";

const OWNER = "owner";
const STRANGER = "stranger";

let harness: ReturnType<typeof lunoraTest>;

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

const newThread = async (userId: string): Promise<any> => await run(async (ctx) => await ctx.db.insert("threads", { status: "active", title: "t", userId }));

const grant = async (threadId: string, userId: string, permission: ThreadPermission, expiresAt?: number): Promise<void> => {
    await run(
        async (ctx) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission, threadId, userId, ...(expiresAt && { expiresAt }) }),
    );
};

/** A deleted row keeps a valid id shape but resolves to nothing. */
const missingThread = async (): Promise<any> => {
    const threadId = await newThread(OWNER);

    await run(async (ctx) => await ctx.db.delete(threadId));

    return threadId;
};

const notFound = expect.objectContaining({ code: "NOT_FOUND" });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

describe("requireOwnedThread", () => {
    it("returns the owner's thread", async () => {
        const threadId = await newThread(OWNER);

        await expect(run(async (ctx) => await requireOwnedThread(ctx, threadId, OWNER))).resolves.toMatchObject({ _id: threadId, userId: OWNER });
    });

    it("refuses a grantee — even an admin one — because owner-only rows must not be planted by anyone else", async () => {
        const threadId = await newThread(OWNER);

        await grant(threadId, STRANGER, "admin");

        await expect(run(async (ctx) => await requireOwnedThread(ctx, threadId, STRANGER))).rejects.toThrow(notFound);
    });

    it("answers a missing thread exactly like a stranger's", async () => {
        const threadId = await missingThread();

        await expect(run(async (ctx) => await requireOwnedThread(ctx, threadId, OWNER))).rejects.toThrow(notFound);
    });
});

describe("requireThreadPermission", () => {
    it("gives the owner admin", async () => {
        const threadId = await newThread(OWNER);

        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, OWNER, "admin"))).resolves.toMatchObject({
            permission: "admin",
            thread: { _id: threadId },
        });
    });

    it("lets a grantee through up to their permission and no further", async () => {
        const threadId = await newThread(OWNER);

        await grant(threadId, STRANGER, "write");

        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, STRANGER, "read"))).resolves.toMatchObject({ permission: "write" });
        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, STRANGER, "write"))).resolves.toMatchObject({ permission: "write" });
        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, STRANGER, "admin"))).rejects.toThrow(notFound);
    });

    it("refuses an expired grant", async () => {
        const threadId = await newThread(OWNER);

        await grant(threadId, STRANGER, "admin", 1);

        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, STRANGER, "read"))).rejects.toThrow(notFound);
    });

    it("treats a public thread as no access — its redacted view authorizes nothing", async () => {
        const threadId = await run(async (ctx) => await ctx.db.insert("threads", { isPublic: true, status: "active", title: "t", userId: OWNER }));

        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, STRANGER, "read"))).rejects.toThrow(notFound);
    });

    it("answers a missing thread exactly like a stranger's", async () => {
        const threadId = await missingThread();

        await expect(run(async (ctx) => await requireThreadPermission(ctx, threadId, OWNER, "read"))).rejects.toThrow(notFound);
    });
});

describe("requireThreadPermissionInAction", () => {
    const actionContext = (answer: { hasAccess: boolean; permission: ThreadPermission | null }) => {
        const calls: unknown[] = [];

        return {
            calls,
            context: {
                runQuery: async (_reference: unknown, args: unknown) => {
                    calls.push(args);

                    return answer;
                },
            } as never,
        };
    };

    it("asks for the required level and returns the granted permission", async () => {
        const { calls, context } = actionContext({ hasAccess: true, permission: "admin" });

        await expect(requireThreadPermissionInAction(context, "t1" as never, OWNER, "write")).resolves.toBe("admin");
        expect(calls).toEqual([{ requiredPermission: "write", threadId: "t1", userId: OWNER }]);
    });

    it("throws the same NOT_FOUND as the database variant", async () => {
        const { context } = actionContext({ hasAccess: false, permission: null });

        await expect(requireThreadPermissionInAction(context, "t1" as never, STRANGER, "read")).rejects.toThrow(notFound);
    });
});
