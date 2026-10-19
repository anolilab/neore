/**
 * Collaborator notifications for a chat that gets locked. The harness is one
 * database, so the fan-out's per-user shard routing is checked on the scheduler
 * call's `shardKey`; the cross-shard hop itself is not exercised here.
 */
import { lunoraTest } from "@lunora/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { enableThreadLock } from "../agent/thread-lock";
import { LOCKED_THREAD_TITLE } from "../lib/thread-lock";
import { runInShard } from "../lib/shard-context";
import { MAX_LENGTH } from "../lib/validators";
import schema from "../schema";
import { threadIdOfLink } from "./locked-link";
import { granteesOf, REDACT_BATCH, redactLockedLinks, scheduleGranteeRedaction } from "./locked-redact";
import { notify } from "./notify";

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

const OWNER = "owner-user";
const GRANTEE = "former-collaborator";
const OTHER = "unrelated-user"; // secret-scanner:allow a test user id
const PASSCODE = "passcode-1";

type Harness = ReturnType<typeof lunoraTest>;
let harness: Harness;
let threadId: string;
let otherThreadId: string;

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = "s".repeat(40);
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Salary", userId: OWNER }));
    otherThreadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Other", userId: OWNER }));
});

const insertNotification = (ctx: any, fields: Record<string, unknown>) =>
    ctx.db.insert("notifications", { createdAt: 1, title: "Salary", type: "task", userId: GRANTEE, ...fields });

const rowsOf = (ids: string[]) => harness.run(async (ctx: any) => await Promise.all(ids.map(async (id) => await ctx.db.get(id))));

/**
 * The harness cannot dispatch a job scheduled by reference, so each queued
 * redaction runs with its own args, until a run queues no further one.
 */
const runQueuedRedactions = async () => {
    const done = new Set<string>();

    for (;;) {
        const pending = harness.scheduler.list().filter((job) => job.functionPath?.includes("redactLockedLinks") === true && !done.has(job.id));

        if (pending.length === 0) {
            return;
        }

        for (const job of pending) {
            done.add(job.id);
            await harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, job.args as never));
        }
    }
};

describe("linking a notification to its chat", () => {
    it("matches only the exact chat id", () => {
        expect(threadIdOfLink("/chat/abc")).toBe("abc");
        expect(threadIdOfLink("/chat/abc/extra?x=1")).toBe("abc");
        expect(threadIdOfLink("/chatty")).toBeUndefined();
        expect(threadIdOfLink(undefined)).toBeUndefined();
    });
});

describe("granteesOf", () => {
    it("lists each accepted invitee once, ignoring pending invites and the owner", () => {
        expect(granteesOf([{ acceptedBy: GRANTEE }, { acceptedBy: GRANTEE }, { acceptedBy: OWNER }, {}], OWNER)).toEqual([GRANTEE]);
    });
});

describe("the per-user redaction job", () => {
    it("rewrites only this user's rows for this chat, and a repeat run changes nothing", async () => {
        const ids = await harness.run(async (ctx: any) => [
            await insertNotification(ctx, { body: "reply text", link: `/chat/${threadId}`, title: "Salary" }),
            await insertNotification(ctx, { body: "fine", link: `/chat/${otherThreadId}`, title: "Other" }),
            await insertNotification(ctx, { link: `/chat/${threadId}`, title: "Salary" }),
            await insertNotification(ctx, { link: `/chat/${threadId}`, title: "Salary", userId: OTHER }),
        ]);

        await harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, { threadId, userId: GRANTEE }));
        const once = await rowsOf(ids);

        expect(once[0]).toMatchObject({ title: LOCKED_THREAD_TITLE });
        expect(once[0]?.body).toBeUndefined();
        expect(once[1]).toMatchObject({ body: "fine", title: "Other" });
        expect(once[2]).toMatchObject({ title: LOCKED_THREAD_TITLE });
        expect(once[3]).toMatchObject({ title: "Salary" });

        await harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, { threadId, userId: GRANTEE }));
        expect(await rowsOf(ids)).toEqual(once);
    });

    it("works through one page at a time and resumes from its cursor", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < REDACT_BATCH + 1; index += 1) {
                await insertNotification(ctx, { createdAt: index + 1, link: `/chat/${threadId}`, title: "Salary" });
            }
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, { threadId, userId: GRANTEE }));

        const continuation = harness.scheduler.list().filter((job) => job.functionPath?.includes("redactLockedLinks") === true);

        expect(continuation).toHaveLength(1);
        const { cursor } = (continuation[0]?.args ?? {}) as { cursor?: string };

        expect(cursor).toBeTypeOf("string");
        expect(cursor?.length).toBeLessThan(MAX_LENGTH.cursor);

        await runQueuedRedactions();

        const titles = await harness.run(async (ctx: any) => {
            const { page } = await ctx.db
                .query("notifications")
                .withIndex("by_userId_createdAt", (q: any) => q.eq("userId", GRANTEE))
                .paginate({ cursor: null, numItems: 500 });

            return page.map((row: { title: string }) => row.title);
        });

        expect(titles).toHaveLength(REDACT_BATCH + 1);
        expect(titles.every((title: string) => title === LOCKED_THREAD_TITLE)).toBe(true);
    });

    it("refuses a cursor longer than the cursor bound", async () => {
        await expect(
            harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, { cursor: "c".repeat(MAX_LENGTH.cursor + 1), threadId, userId: GRANTEE })),
        ).rejects.toThrow();
    });

    it("redacts pending outbox mail for the notification but not mail already sent", async () => {
        const ids = await harness.run(async (ctx: any) => {
            const notificationId = await insertNotification(ctx, { link: `/chat/${threadId}`, title: "Salary" });
            const base = { attempts: 0, createdAt: 1, link: `/chat/${threadId}`, notificationId, title: "Salary", userId: GRANTEE };
            const pending = await ctx.db.insert("outcomeEmails", { ...base, status: "pending" });
            const sent = await ctx.db.insert("outcomeEmails", { ...base, sentAt: 2, status: "sent" });

            return { pending, sent };
        });

        await harness.run(async (ctx: any) => await ctx.runMutation(redactLockedLinks, { threadId, userId: GRANTEE }));

        const [pending, sent] = await harness.run(async (ctx: any) => [await ctx.db.get(ids.pending), await ctx.db.get(ids.sent)]);

        expect(pending).toMatchObject({ title: LOCKED_THREAD_TITLE });
        expect(sent).toMatchObject({ title: "Salary" });
    });
});

describe("locking a chat that had collaborators", () => {
    it("schedules one redaction per former collaborator, each on that user's shard", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadInvites", {
                acceptedBy: GRANTEE,
                expiresAt: Date.now() + 1e6,
                invitedBy: OWNER,
                invitedEmail: "a@x",
                inviteToken: "t1",
                permission: "read",
                status: "revoked",
                threadId,
            });
            await ctx.db.insert("threadInvites", {
                expiresAt: Date.now() + 1e6,
                invitedBy: OWNER,
                invitedEmail: "b@x",
                inviteToken: "t2",
                permission: "read",
                status: "pending",
                threadId,
            });
        });

        const runAfter = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "job");

        await harness.run(async (ctx: any) => await scheduleGranteeRedaction({ db: ctx.db, scheduler: { runAfter } } as never, threadId as never, OWNER));

        expect(runAfter).toHaveBeenCalledTimes(1);
        expect(runAfter.mock.calls[0]?.[3]).toEqual({ shardKey: GRANTEE });
        expect(runAfter.mock.calls[0]?.[2]).toEqual({ threadId, userId: GRANTEE });
    });

    it("schedules every collaborator past the first page, once each, dispatched at once", async () => {
        // 150 accepted invites, more than one page. The last one repeats the first collaborator.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 150; index += 1) {
                await ctx.db.insert("threadInvites", {
                    acceptedBy: index === 149 ? "user-0" : `user-${index}`,
                    expiresAt: Date.now() + 1e6,
                    invitedBy: OWNER,
                    invitedEmail: `${index}@x`,
                    inviteToken: `t${index}`,
                    permission: "read",
                    status: "accepted",
                    threadId,
                });
            }
        });

        const runAfter = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "job");

        await harness.run(async (ctx: any) => await scheduleGranteeRedaction({ db: ctx.db, scheduler: { runAfter } } as never, threadId as never, OWNER));

        const users = runAfter.mock.calls.map((call) => (call[2] as { userId: string }).userId);

        expect(users).toHaveLength(149);
        expect(new Set(users).size).toBe(149);
        expect(users).toContain("user-148");
        expect(runAfter.mock.calls.every((call) => call[0] === 0)).toBe(true);
    });

    it("schedules nothing for a chat whose invites belong to another chat", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadInvites", {
                acceptedBy: GRANTEE,
                expiresAt: Date.now() + 1e6,
                invitedBy: OWNER,
                invitedEmail: "a@x",
                inviteToken: "t-other",
                permission: "read",
                status: "accepted",
                threadId: otherThreadId,
            });
        });

        const runAfter = vi.fn<(...args: unknown[]) => Promise<string>>(async () => "job");

        await harness.run(async (ctx: any) => await scheduleGranteeRedaction({ db: ctx.db, scheduler: { runAfter } } as never, threadId as never, OWNER));

        expect(runAfter).not.toHaveBeenCalled();
    });

    it("redacts a former collaborator's earlier notification when the owner locks the chat", async () => {
        const id = await harness.run(async (ctx: any) => {
            await ctx.db.insert("threadInvites", {
                acceptedBy: GRANTEE,
                expiresAt: Date.now() + 1e6,
                invitedBy: OWNER,
                invitedEmail: "a@x",
                inviteToken: "t1",
                permission: "read",
                status: "revoked",
                threadId,
            });

            return await insertNotification(ctx, { body: "reply text", link: `/chat/${threadId}`, title: "Salary" });
        });

        await harness.withIdentity({ userId: OWNER } as never).mutation(enableThreadLock as never, { passcode: PASSCODE, threadId } as never);

        expect(harness.scheduler.list().some((job) => job.functionPath?.includes("redactLockedLinks") === true)).toBe(true);

        await runQueuedRedactions();

        const row = await rowsOf([id]);

        expect(row[0]).toMatchObject({ title: LOCKED_THREAD_TITLE });
        expect(row[0]?.body).toBeUndefined();
    });
});

describe("a notification written after the lock", () => {
    it("is redacted on the owner's shard before it is handed to the recipient", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch(threadId, { lockedAt: Date.now() }));

        await harness.run(
            async (ctx: any) =>
                await runInShard(
                    OWNER,
                    async () => await notify(ctx, { body: "reply text", link: `/chat/${threadId}`, title: "Salary", type: "task", userId: GRANTEE }),
                ),
        );

        const handoff = harness.scheduler.list().find((job) => job.functionPath?.includes("createNotification") === true);

        expect(handoff).toBeDefined();
        expect(handoff?.args).toMatchObject({ title: LOCKED_THREAD_TITLE, userId: GRANTEE });
        expect((handoff?.args as { body?: string }).body).toBeUndefined();
    });
});
