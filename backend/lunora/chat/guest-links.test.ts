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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => {} };
});

const { default: schema } = await import("../schema");
const guestLinks = await import("./guest-links");
const { _deletePageForThreadId, createTemporaryThread, markThreadArchived } = await import("../agent/threads");
const { enableThreadLock } = await import("../agent/thread-lock");

const OWNER = "user-owner";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

/** A link on `thread` with `messages` held notes and its route, as a guest's posts would leave them. */
const seedLink = async (thread: string, linkHash: string, expiresAt: number, messages = 1) =>
    await harness.run(async (ctx: any) => {
        const linkId = await ctx.db.insert("threadGuestLinks", { createdAt: 0, expiresAt, linkHash, threadId: thread, userId: OWNER });

        for (let index = 0; index < messages; index += 1) {
            await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId, status: "held", text: `m${index}`, threadId: thread, userId: OWNER });
        }

        await setShardRoute(ctx, "guest-link", linkHash, OWNER);
    });

beforeAll(async () => {
    registerModule(registry, "chat_guest_links", guestLinks);
}, 60_000);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    vi.unstubAllEnvs();
    harness.close();
});

describe("withdrawing a link", () => {
    const withdrawals: [string, () => Promise<unknown>][] = [
        ["archived", async () => await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: Date.now() }, threadId as never))],
        ["deleted", async () => await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }))],
        [
            "made temporary",
            async () => await harness.run(async (ctx: any) => await ctx.runMutation(createTemporaryThread, { expiresAt: Date.now() + 1, threadId })),
        ],
        [
            "locked",
            async () => {
                vi.stubEnv("STORAGE_SIGNING_SECRET", "test-secret");
                await harness.withIdentity({ userId: OWNER } as never).mutation(enableThreadLock as never, { passcode: "correct horse 42", threadId } as never);
            },
        ],
    ];

    it.each(withdrawals)("removes the link, its messages and its route when the thread is %s", async (_label, withdraw) => {
        await seedLink(threadId, "hash-live", Date.now() + 60_000);
        await withdraw();

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });
});

describe("the sweep", () => {
    it("removes lapsed links with their messages and routes, keeping live ones", async () => {
        const otherThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER }))) as string;

        await seedLink(threadId, "hash-lapsed", 1);
        await seedLink(otherThread, "hash-live", Date.now() + 60_000, 0);
        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));

        expect(await rows("threadGuestLinks")).toMatchObject([{ linkHash: "hash-live" }]);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toMatchObject([{ key: "guest-link:hash-live" }]);
    });
});

describe("erasing the account", () => {
    it("removes the messages, then the links and their routes", async () => {
        await seedLink(threadId, "hash-live", Date.now() + 60_000, BATCH + 1);

        const erase = async () => (await harness.run(async (ctx: any) => await erasePersistentStreamsForUser(ctx, OWNER))) as { hasMore: boolean };

        expect((await erase()).hasMore).toBe(true);
        expect(await rows("threadGuestLinks")).toHaveLength(1);
        expect((await erase()).hasMore).toBe(false);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });
});
