/**
 * The text a phone fetches for a push that carried only ids: owner-only, generic for a chat that is locked,
 * passcode-protected, deleted, archived or no longer the caller's to read (checked when the request comes in, on the
 * chat's own shard), bounded, rate-limited.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { callOnShard } from "../lib/cross-shard";
import { checkRateLimit } from "../lib/rate-limiter";
import { threadShardFor } from "../lib/thread-shard";
import schema from "../schema";
import { loadPhonePushContent, readThreadLockState } from "./phone-content";
import { PUSH_CONTENT_MAX_BODY_BYTES, pushContentHttpAction } from "./push-content-http";

vi.mock("../lib/cross-shard", () => {
    return { callOnShard: vi.fn() };
});

vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: vi.fn(async (_context: unknown, userId: string) => userId) };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        checkRateLimit: vi.fn(async () => {
            return { ok: true };
        }),
    };
});

const USER = "user-a";
const OTHER = "user-b";

let harness: ReturnType<typeof lunoraTest>;

type Handler<R> = { handler: (ctx: object, args: Record<string, unknown>) => Promise<R> };

const call = async <R>(procedure: unknown, userId: string | null, args: Record<string, unknown>): Promise<R> =>
    await harness.run(async (ctx: object) => await (procedure as Handler<R>).handler({ ...ctx, auth: { userId } }, args));

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.mocked(checkRateLimit).mockClear();
    vi.restoreAllMocks();
});

describe("phone push content", () => {
    const seed = async () =>
        await harness.run(async (ctx: any) => {
            const lockedThread = await ctx.db.insert("threads", { lockedAt: 1, status: "active", title: "Salary", userId: USER });
            const plain = await ctx.db.insert("notifications", {
                body: "Deploy the site",
                createdAt: 1,
                link: "/chat/t1",
                title: "Release run",
                type: "tool_approval",
                userId: USER,
            });
            const locked = await ctx.db.insert("notifications", {
                createdAt: 1,
                link: `/chat/${String(lockedThread)}`,
                title: "Salary",
                type: "task",
                userId: USER,
            });

            return { locked: locked as string, plain: plain as string };
        });

    it("gives the text only when the signed-in session's user owns the notification; a locked chat only the generic answer", async () => {
        const { locked, plain } = await seed();

        expect(await call(loadPhonePushContent, null, { notificationId: plain, userId: USER })).toStrictEqual({
            body: "Release run\nDeploy the site",
            threadId: "t1",
            title: "A tool call needs your approval",
        });
        expect(await call(loadPhonePushContent, null, { notificationId: plain, userId: OTHER })).toBeNull();
        // A well-formed string that is no notification id reads as nothing: the same 404, never an outage.
        expect(await call(loadPhonePushContent, null, { notificationId: "mine", userId: USER })).toBeNull();
        expect(await call(loadPhonePushContent, null, { notificationId: locked, userId: USER })).toStrictEqual({ generic: true });
    });

    it("keeps a notification that links anywhere but a chat generic: it can carry chat content with no chat to check", async () => {
        const ids = await harness.run(async (ctx: any) => {
            const insert = async (link: string | undefined) =>
                (await ctx.db.insert("notifications", {
                    body: "The final answer from a chat",
                    createdAt: 1,
                    ...(link !== undefined && { link }),
                    title: "Weekly report",
                    type: "task",
                    userId: USER,
                })) as string;

            return [await insert("/tasks"), await insert("/dashboard"), await insert(undefined)];
        });

        for (const notificationId of ids) {
            expect(await call(loadPhonePushContent, null, { notificationId, userId: USER })).toStrictEqual({ generic: true });
        }
    });

    const request = (body: unknown) => new Request("https://api.test/notifications/push-content", { body: JSON.stringify(body), method: "POST" });

    it("answers the HTTP request for the signed-in caller only, the same 404 for any id that is not theirs", async () => {
        const runQuery = vi.fn(async (reference: unknown, args: { notificationId?: string }) => {
            if (reference === internal.notifications.phone_content.readThreadLockState) {
                return "open";
            }

            return args.notificationId === "mine" ? { body: "b", threadId: "t1", title: "t" } : null;
        });
        const as = (userId: string | null) => ({ auth: { userId }, runQuery }) as never;

        const statusOf = async (userId: string | null, body: unknown) => {
            const response = await pushContentHttpAction(as(userId), request(body));

            return response.status;
        };

        expect(await statusOf(null, { notificationId: "mine" })).toBe(401);
        expect(await statusOf(USER, {})).toBe(400);
        expect(await statusOf(USER, { notificationId: "theirs" })).toBe(404);

        const response = await pushContentHttpAction(as(USER), request({ notificationId: "mine" }));

        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toStrictEqual({ body: "b", title: "t" });
        expect(runQuery).toHaveBeenCalledWith(internal.notifications.phone_content.loadPhonePushContent, { notificationId: "mine", userId: USER });
        expect(runQuery).toHaveBeenLastCalledWith(internal.notifications.phone_content.readThreadLockState, { threadId: "t1", userId: USER });
    });

    it("reads a chat where it lives: text only while the caller can still read it and it is not locked, deleted or archived", async () => {
        const ids = await harness.run(async (ctx: any) => {
            const thread = async (fields: object) => (await ctx.db.insert("threads", { status: "active", title: "Chat", userId: USER, ...fields })) as string;
            const shared = await thread({});

            await ctx.db.insert("threadAccess", { grantedAt: 1, grantedBy: USER, ownerId: USER, permission: "read", threadId: shared, userId: OTHER });

            return {
                archived: await thread({ status: "archived" }),
                deleted: await thread({ deleted: true, deletedAt: 9 }),
                locked: await thread({ lockedAt: 7 }),
                open: await thread({}),
                shared,
            };
        });
        const stateOf = async (threadId: string, userId = USER) => await call(readThreadLockState, null, { threadId, userId });

        expect(await stateOf(ids.open)).toBe("open");
        expect(await stateOf(ids.locked)).toBe("locked");
        expect(await stateOf(ids.deleted)).toBe("missing");
        expect(await stateOf(ids.archived)).toBe("missing");
        expect(await stateOf("gone")).toBe("missing");
        // A collaborator reads a shared chat while the grant holds, and nothing of a chat that is not theirs.
        expect(await stateOf(ids.shared, OTHER)).toBe("open");
        expect(await stateOf(ids.open, OTHER)).toBe("missing");
        // A locked chat is the owner's alone: a collaborator gets nothing of it either.
        expect(await stateOf(ids.locked, OTHER)).toBe("missing");
    });

    describe("a chat locked after the push went out", () => {
        const text = { body: "Release run", threadId: "t1", title: "A tool call needs your approval" };
        const contentFor = async (runQuery: ReturnType<typeof vi.fn>) => {
            const response = await pushContentHttpAction({ auth: { userId: USER }, runQuery } as never, request({ notificationId: "n1" }));

            return await response.json();
        };
        /** The content query answers `text`; the lock query on the caller's own shard answers `ownState`. */
        const runner = (ownState: string) =>
            vi.fn(async (reference: unknown) => (reference === internal.notifications.phone_content.readThreadLockState ? ownState : text));

        it("gives the text for the caller's own chat only while it is open, checked when the request comes in (a lock or delete can come later)", async () => {
            expect(await contentFor(runner("open"))).toStrictEqual({ body: "Release run", title: "A tool call needs your approval" });
            expect(await contentFor(runner("locked"))).toStrictEqual({ generic: true });
            expect(await contentFor(runner("missing"))).toStrictEqual({ generic: true });
        });

        it("reads a shared chat's lock on its owner's shard, and stays generic when that fails", async () => {
            vi.mocked(threadShardFor).mockResolvedValue("owner-shard");
            vi.spyOn(console, "error").mockImplementation(() => undefined);

            try {
                vi.mocked(callOnShard).mockResolvedValueOnce("locked" as never);
                expect(await contentFor(runner("open"))).toStrictEqual({ generic: true });
                expect(callOnShard).toHaveBeenLastCalledWith(
                    internal.notifications.phone_content.readThreadLockState,
                    { threadId: "t1", userId: USER },
                    { shardKey: "owner-shard" },
                );

                vi.mocked(callOnShard).mockResolvedValueOnce("open" as never);
                expect(await contentFor(runner("open"))).toStrictEqual({ body: "Release run", title: "A tool call needs your approval" });

                vi.mocked(callOnShard).mockRejectedValueOnce(new Error("shard unreachable"));
                expect(await contentFor(runner("open"))).toStrictEqual({ generic: true });
            } finally {
                vi.mocked(threadShardFor).mockImplementation(async (_context: unknown, userId: string) => userId);
            }
        });
    });

    it("refuses a string that is not an id before any read", async () => {
        const runQuery = vi.fn();

        const response = await pushContentHttpAction({ auth: { userId: USER }, runQuery } as never, request({ notificationId: "../../x" }));

        expect(response.status).toBe(400);
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("logs a failure on our side and answers 503, kept apart from not found", async () => {
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const runQuery = vi.fn(async () => {
            throw new Error("D1_ERROR: database is locked");
        });

        const response = await pushContentHttpAction({ auth: { userId: USER }, runQuery } as never, request({ notificationId: "n1" }));

        expect(response.status).toBe(503);
        expect(await response.json()).toStrictEqual({ error: "UNAVAILABLE" });
        expect(error).toHaveBeenCalledWith("[notifications] push-content lookup failed:", expect.any(Error));
    });

    it("refuses a body past the cap, read in chunks, before any read of the notification", async () => {
        const runQuery = vi.fn();
        const huge = new Request("https://api.test/notifications/push-content", {
            body: JSON.stringify({ notificationId: "x".repeat(PUSH_CONTENT_MAX_BODY_BYTES) }),
            method: "POST",
        });

        const response = await pushContentHttpAction({ auth: { userId: USER }, runQuery } as never, huge);

        expect(response.status).toBe(413);
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("answers 429 past the caller's rate limit, before any read", async () => {
        const runQuery = vi.fn();

        vi.mocked(checkRateLimit).mockResolvedValueOnce({ ok: false });

        const response = await pushContentHttpAction({ auth: { userId: USER }, runQuery } as never, request({ notificationId: "n1" }));

        expect(response.status).toBe(429);
        expect(runQuery).not.toHaveBeenCalled();
    });
});
