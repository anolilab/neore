/**
 * A pull request watch's wake turn and the thread lock (`pr-watch-wake-lease.ts`): locking a chat waits while a wake turn holds it, and
 * a turn is not claimed or started in a chat that is locked. Either the lock commits first and no turn starts, or the turn is claimed
 * and the lock waits, as for a title or follow-up model request. The lock is the real `enableThreadLock`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _deletePageForThreadId, softDeleteThread } from "../agent/threads";
import { enableThreadLock } from "../agent/thread-lock";
import { insertThread } from "../agent/table-writes";
import schema from "../schema";
import { heldWakeLeases } from "./pr-watch-wake-lease";

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
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

const OWNER = "owner-wake-lock";
const PASSCODE = "passcode-1";

let harness: ReturnType<typeof lunoraTest>;

beforeEach(() => {
    process.env.STORAGE_SIGNING_SECRET = "test-storage-signing-secret";
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
});

const seed = async (lease: number | undefined, number = 7): Promise<{ linkId: string; threadId: string }> =>
    await harness.run(async (ctx: any) => {
        const threadId = await insertThread(ctx.db, {
            createdBy: OWNER,
            mode: "text",
            status: "active",
            tags: ["chat"],
            title: "work",
            updatedAt: Date.now(),
            userId: OWNER,
        });
        const linkId = await ctx.db.insert("pullRequestThreads", {
            createdAt: 0,
            kind: "linked",
            number,
            repository: "octo/hello",
            threadId,
            title: "pull",
            url: `https://github.com/octo/hello/pull/${String(number)}`,
            userId: OWNER,
            ...(lease !== undefined && { watchWakeLeaseUntil: lease }),
        });

        return { linkId: String(linkId), threadId: String(threadId) };
    });

const lock = async (threadId: string) =>
    await harness.withIdentity({ userId: OWNER } as never).mutation(enableThreadLock as never, { passcode: PASSCODE, threadId } as never);

describe("locking a chat while a wake turn holds it", () => {
    it("refuses while the turn's lease is held, and locks once it is released", async () => {
        const { linkId, threadId } = await seed(Date.now() + 60_000);

        await expect(lock(threadId)).rejects.toMatchObject({ message: expect.stringContaining("pull request watch") });

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: 0 });
        });
        await expect(lock(threadId)).resolves.toBeDefined();
    });

    it("locks a chat whose wake lease has lapsed", async () => {
        const { threadId } = await seed(Date.now() - 1000);

        await expect(lock(threadId)).resolves.toBeDefined();
    });
});

describe("deleting a chat while a wake turn holds it", () => {
    const trash = async (threadId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(softDeleteThread, { threadId }));
    const purge = async (threadId: string) => await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }));

    it("refuses both delete paths while the lease is held, and proceeds once it lapses", async () => {
        const { linkId, threadId } = await seed(Date.now() + 60_000);

        await expect(trash(threadId)).rejects.toMatchObject({ message: expect.stringContaining("pull request watch") });
        await expect(purge(threadId)).rejects.toMatchObject({ message: expect.stringContaining("pull request watch") });

        // Nothing was written: the chat is not marked deleted or deleting.
        const held = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

        expect(held.deleted).toBeUndefined();
        expect(held.deletingAt).toBeUndefined();

        await harness.run(async (ctx: any) => {
            await ctx.db.patch("pullRequestThreads", linkId, { watchWakeLeaseUntil: Date.now() - 1000 });
        });
        await expect(trash(threadId)).resolves.toBeDefined();
    });
});

describe("heldWakeLeases", () => {
    it("lists the other links of a thread that hold a lease, and none that do not", async () => {
        const { linkId, threadId } = await seed(Date.now() + 60_000);

        const other = await harness.run(async (ctx: any) =>
            String(
                await ctx.db.insert("pullRequestThreads", {
                    createdAt: 0,
                    kind: "linked",
                    number: 8,
                    repository: "octo/hello",
                    threadId,
                    title: "pull 8",
                    url: "https://github.com/octo/hello/pull/8",
                    userId: OWNER,
                }),
            ),
        );
        const held = async (except?: string) =>
            await harness.run(async (ctx: any) => {
                const ids = await heldWakeLeases(ctx, OWNER, threadId as never, Date.now(), except as never);

                return ids.map(String);
            });

        expect(await held()).toEqual([linkId]);
        expect(await held(linkId)).toEqual([]);
        expect(await held(other)).toEqual([linkId]);
    });
});
