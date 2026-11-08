/* eslint-disable unicorn/no-await-expression-member */
/**
 * Guest links, the server-side lifecycle: a link and what guests left on it go when the thread is archived, deleted,
 * made temporary or locked, when the link lapses, and when the account is erased.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { BATCH } from "../gdpr/batch";
import { setShardRoute } from "../lib/shard-routes";
import { erasePersistentStreamsForUser } from "./gdpr";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, userId } : null;
        },
    };
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

/** Route deletes still to fail, as a global-storage outage would, and how many were made. */
const routeFailures = vi.hoisted(() => {
    return { deletes: 0, left: 0 };
});

vi.mock("../lib/shard-routes", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lib/shard-routes")>();

    return {
        ...original,
        deleteShardRoute: async (...args: Parameters<typeof original.deleteShardRoute>) => {
            routeFailures.deletes += 1;

            if (routeFailures.left > 0) {
                routeFailures.left -= 1;

                throw new Error("global storage unavailable");
            }

            await original.deleteShardRoute(...args);
        },
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => {} };
});

const { default: schema } = await import("../schema");
const guestLinks = await import("./guest-links");
const { _deletePageForThreadId, createTemporaryThread, markThreadArchived, softDeleteThread } = await import("../agent/threads");
const { enableThreadLock } = await import("../agent/thread-lock");
const { GUEST_ROUTE_BATCH, scheduleGuestLinkRouteDrop, withdrawGuestLinksForThread } = await import("./lib/guest-link-store");

const OWNER = "user-owner";

/** The pinned clock every test runs at, so an expiry is decided by the values here and never by how long a test took. */
const NOW = Date.UTC(2026, 0, 15, 12);

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

/** A link on `thread` with `messages` held notes and its route, as a guest's posts would leave them. */
const seedLink = async (thread: string, linkHash: string, expiresAt: number, messages = 1, createdAt = 0) =>
    await harness.run(async (ctx: any) => {
        const linkId = await ctx.db.insert("threadGuestLinks", { createdAt, expiresAt, linkHash, threadId: thread, userId: OWNER });

        for (let index = 0; index < messages; index += 1) {
            await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId, status: "held", text: `m${index}`, threadId: thread, userId: OWNER });
        }

        await setShardRoute(ctx, "guest-link", linkHash, OWNER);
    });

/**
 * Runs the route removals the fake scheduler holds, and the retries they schedule, once each: it cannot resolve a
 * shard-routed job itself, so each is run here with the args it was given.
 */
const runRouteDrops = async () => {
    const ran = new Set<string>();

    for (let pass = 0; pass < 10; pass += 1) {
        const due = harness.scheduler.list().filter((job) => "linkHashes" in job.args && !ran.has(job.id));

        if (due.length === 0) {
            return;
        }

        for (const job of due) {
            ran.add(job.id);
            await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.dropGuestLinkRoutesJob, job.args));
        }
    }
};

beforeAll(async () => {
    registerModule(registry, "chat_guest_links", guestLinks);
}, 60_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    vi.useRealTimers();
    routeFailures.deletes = 0;
    routeFailures.left = 0;
    vi.unstubAllEnvs();
    harness.close();
});

describe("withdrawing a link", () => {
    const withdrawals: [string, () => Promise<unknown>][] = [
        ["archived", async () => await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: NOW }, threadId as never))],
        ["deleted", async () => await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }))],
        ["trashed", async () => await harness.run(async (ctx: any) => await ctx.runMutation(softDeleteThread, { threadId }))],
        ["made temporary", async () => await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { expiresAt: NOW + 1, threadId }))],
        [
            "locked",
            async () => {
                vi.stubEnv("STORAGE_SIGNING_SECRET", "test-secret");
                await harness.withIdentity({ userId: OWNER } as never).mutation(enableThreadLock as never, { passcode: "correct horse 42", threadId } as never);
            },
        ],
    ];

    it.each(withdrawals)("removes the link, its messages and its route when the thread is %s", async (_label, withdraw) => {
        // A full link: exactly one removal page of notes, which one pass finishes.
        await seedLink(threadId, "hash-live", NOW + 60_000, 100);
        await withdraw();
        await runRouteDrops();

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });
});

describe("a link's route", () => {
    it("stays when the write that withdrew the link fails", async () => {
        await seedLink(threadId, "hash-live", NOW + 60_000);

        await expect(
            harness.run(async (ctx: any) => {
                await withdrawGuestLinksForThread({ ...ctx, now: NOW }, threadId as never);

                throw new Error("a later step of the lock failed");
            }),
        ).rejects.toThrow();

        // Global storage keeps what a failed shard write did to it; the harness rolls both back, so the delete is counted.
        expect(routeFailures.deletes).toBe(0);

        await runRouteDrops();

        expect(await rows("threadGuestLinks")).toHaveLength(1);
        expect(await rows("shardRoutes")).toHaveLength(1);
    });

    it("is removed on a retry when its first delete throws", async () => {
        await seedLink(threadId, "hash-live", NOW + 60_000);
        routeFailures.left = 1;
        await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: NOW }, threadId as never));
        await runRouteDrops();

        expect(routeFailures.left).toBe(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });

    it("is removed in jobs of at most one batch each when more hashes are handed over", async () => {
        const hashes = Array.from({ length: GUEST_ROUTE_BATCH * 2 + 20 }, (_unused, index) => `hash-${index}`);

        await harness.run(async (ctx: any) => await scheduleGuestLinkRouteDrop(ctx, hashes));

        expect(harness.scheduler.list().map((job) => (job.args["linkHashes"] as string[]).length)).toEqual([GUEST_ROUTE_BATCH, GUEST_ROUTE_BATCH, 20]);
        // Each job's input passes the job's own validator.
        await runRouteDrops();
    });

    it("is kept while a link row with its hash still exists", async () => {
        await seedLink(threadId, "hash-live", NOW + 60_000);
        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.dropGuestLinkRoutesJob, { attempt: 0, linkHashes: ["hash-live"] }));

        expect(await rows("shardRoutes")).toHaveLength(1);
    });
});

describe("withdrawing a link with more than one page of messages", () => {
    it("finishes it in a continuation, which leaves a link made after the withdrawal", async () => {
        await seedLink(threadId, "hash-old", NOW + 60_000, 101);
        await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: NOW }, threadId as never));

        expect(await rows("threadGuestLinks")).toHaveLength(1);

        // The owner restores the thread and gives out a new link before the continuation runs.
        // As links are made: expiry follows creation, so the later link also lapses later.
        await seedLink(threadId, "hash-new", NOW + 1000 + 60_000, 1, NOW + 1000);
        // The fake scheduler cannot resolve a shard-routed job, so the job it holds is run here with the args it was given.
        const [job] = harness.scheduler.list();

        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.continueGuestLinkRemoval, job?.args));
        await runRouteDrops();

        expect(await rows("threadGuestLinks")).toMatchObject([{ linkHash: "hash-new" }]);
        expect(await rows("threadGuestMessages")).toHaveLength(1);
        expect(await rows("shardRoutes")).toMatchObject([{ key: "guest-link:hash-new" }]);
    });
});

describe("a withdrawal continuation that meets only links made after it started", () => {
    it("stops instead of scheduling itself again", async () => {
        await seedLink(threadId, "hash-old", NOW + 60_000, 101);
        await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: NOW }, threadId as never));
        const [job] = harness.scheduler.list();

        // The old link is gone by other means, and the restored thread has a full batch of newer links.
        const messages = (await rows("threadGuestMessages")) as { _id: string }[];
        const links = (await rows("threadGuestLinks")) as { _id: string }[];

        await harness.run(async (ctx: any) => {
            for (const message of messages) {
                await ctx.db.delete("threadGuestMessages", message._id);
            }

            for (const link of links) {
                await ctx.db.delete("threadGuestLinks", link._id);
            }
        });

        for (let index = 0; index < 50; index += 1) {
            await seedLink(threadId, `hash-new-${index}`, NOW + 120_000 + index, 0, NOW + 1000 + index);
        }

        const scheduled = harness.scheduler.list().length;

        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.continueGuestLinkRemoval, job?.args));

        expect(harness.scheduler.list()).toHaveLength(scheduled);
        expect(await rows("threadGuestLinks")).toHaveLength(50);
    });
});

describe("withdrawing several links that together hold more than one page of messages", () => {
    it("deletes no more than one page of messages in one write, and leaves the rest to the continuation", async () => {
        await seedLink(threadId, "hash-a", NOW + 60_000, 60);
        await seedLink(threadId, "hash-b", NOW + 60_000, 60);
        await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: NOW }, threadId as never));

        // 60 + 40 of the 120 messages: the first link goes whole, the second keeps its row and its last 20.
        expect(await rows("threadGuestMessages")).toHaveLength(20);
        expect(await rows("threadGuestLinks")).toHaveLength(1);
    });
});

describe("deleting a thread whose link holds more than one page of messages", () => {
    it("leaves no message behind", async () => {
        await seedLink(threadId, "hash-live", NOW + 60_000, 101);

        for (let page = 0; page < 5; page += 1) {
            const { isDone } = (await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }))) as { isDone: boolean };

            if (isDone) {
                break;
            }
        }

        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });
});

describe("the sweep", () => {
    it("carries on past a full batch and a link with more than one page of messages until nothing lapsed is left", async () => {
        // A full batch first, then a link whose messages take more than one page, alone in its batch.
        for (let index = 0; index < 50; index += 1) {
            await seedLink(threadId, `hash-${index}`, 1, 0);
        }

        await seedLink(threadId, "hash-big", 2, 101);

        // Each new sweep job is the sweep's own continuation, run here in its place; the route drops it also queues are not.
        const sweeps = (): number => harness.scheduler.list().filter((job: { args: Record<string, unknown> }) => !("linkHashes" in job.args)).length;

        for (let run = 0; run < 5; run += 1) {
            const before = sweeps();

            await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));

            if (sweeps() === before) {
                break;
            }
        }

        await runRouteDrops();

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });

    it("removes lapsed links with their messages and routes, keeping live ones", async () => {
        const otherThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER }))) as string;

        await seedLink(threadId, "hash-lapsed", 1);
        await seedLink(otherThread, "hash-live", NOW + 60_000, 0);
        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));
        await runRouteDrops();

        expect(await rows("threadGuestLinks")).toMatchObject([{ linkHash: "hash-live" }]);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toMatchObject([{ key: "guest-link:hash-live" }]);
    });
});

describe("erasing the account", () => {
    it("removes the messages, then the links and their routes", async () => {
        await seedLink(threadId, "hash-live", NOW + 60_000, BATCH + 1);

        const erase = async () => (await harness.run(async (ctx: any) => await erasePersistentStreamsForUser(ctx, OWNER))) as { hasMore: boolean };

        expect((await erase()).hasMore).toBe(true);
        expect(await rows("threadGuestLinks")).toHaveLength(1);
        expect((await erase()).hasMore).toBe(false);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });
});
