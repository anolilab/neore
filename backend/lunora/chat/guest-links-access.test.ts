/* eslint-disable unicorn/no-await-expression-member */
/**
 * Guest links, who can reach them: a guest's message is HELD and nothing runs. The owner procedures run under row-level security as the
 * owner; the guest actions run their owner-shard half through the harness, since `callOnShard` needs a Durable Object
 * namespace the harness lacks.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

const registry = vi.hoisted(() => new Map<string, unknown>());
const shard = vi.hoisted(() => {
    return { harness: undefined as unknown as { run: (body: (ctx: any) => Promise<unknown>) => Promise<unknown> } };
});

vi.mock("../lib/cross-shard", () => {
    return {
        callOnShard: async (reference: { kind?: string }, args: never) =>
            await shard.harness.run(async (ctx: any) =>
                reference.kind === "mutation" ? await ctx.runMutation(reference, args) : await ctx.runQuery(reference, args),
            ),
    };
});

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

vi.mock("../auth", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../auth")>()),
        getAuthUserIdentity: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { subject: context.auth.userId, userId: context.auth.userId } : null,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("../lib/rate-limiter")>()), rateLimitGuard: async () => {} };
});

const { default: schema } = await import("../schema");
const guestLinks = await import("./guest-links");
const { GUEST_MAX_HELD_PER_LINK, GUEST_MESSAGE_MAX_CHARS, hashGuestToken } = await import("./lib/guest-link-store");

const OWNER = "user-owner";
const BROWSER = "fresh-browser-token";
const OTHER_BROWSER = /another browser/u;
const NOT_ACTIVE = /not active/u;
const REUSED_REQUEST = /already used for a different message/u;
const LIMITED = /Too many messages on this link/u;
const MINTED_TOKEN = /^[0-9a-f]{64}$/u;

/** Posts one link takes per hour (`guest/message:public` in `lib/rate-limiter.ts`). */
const PER_LINK_ALLOWANCE = 30;

/** The pinned clock every test runs at, so whether a link has lapsed never depends on how long a test took. */
const NOW = Date.UTC(2026, 0, 15, 12);

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const asOwner = () => harness.withIdentity({ userId: OWNER } as never);
const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());
const createLink = async () =>
    (await asOwner().mutation(guestLinks.createGuestLink as never, { threadId } as never)) as { expiresAt: number; linkToken: string };

/** The owner-shard half of a post, with `BROWSER` as the token the first post binds. */
const hold = async (linkToken: string, text: string, guestToken?: string) =>
    (await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(guestLinks.holdGuestMessage, {
                freshGuestHash: await hashGuestToken(BROWSER),
                linkHash: await hashGuestToken(linkToken),
                presentedGuestHash: guestToken === undefined ? undefined : await hashGuestToken(guestToken),
                text,
            }),
    )) as { messageId?: string; minted?: boolean; ok: boolean; reason?: string };

/** Runs the route removals the fake scheduler holds: it cannot resolve a shard-routed job, so each runs here with its args. */
const runRouteDrops = async () => {
    for (const job of harness.scheduler.list()) {
        if ("linkHashes" in job.args) {
            await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.dropGuestLinkRoutesJob, job.args));
        }
    }
};

/** Every held note taken up by the owner, so the held cap does not stop a run before the per-link limit does. */
const settle = async () =>
    await harness.run(async (ctx: any) => {
        const held = await ctx.db.query("threadGuestMessages").collect();

        for (const row of held) {
            await ctx.db.patch("threadGuestMessages", row._id, { status: "sent" });
        }
    });

const lapse = async () =>
    await harness.run(async (ctx: any) => {
        const links = await ctx.db.query("threadGuestLinks").collect();

        for (const link of links) {
            await ctx.db.patch("threadGuestLinks", link._id, { expiresAt: 1 });
        }
    });

beforeAll(async () => {
    registerModule(registry, "chat_guest_links", guestLinks);
}, 60_000);

beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    harness = lunoraTest(schema as never);
    shard.harness = harness as never;
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    vi.useRealTimers();
    harness.close();
});

describe("creating a link", () => {
    it("stores only the token's hash and routes it to the owner", async () => {
        const { linkToken } = await createLink();
        const [link] = (await rows("threadGuestLinks")) as [{ linkHash: string }];

        expect(link.linkHash).toBe(await hashGuestToken(linkToken));
        expect(JSON.stringify(await rows("threadGuestLinks"))).not.toContain(linkToken);
        expect(await rows("shardRoutes")).toMatchObject([{ key: `guest-link:${link.linkHash}`, ownerId: OWNER }]);
    });

    it("is refused to a stranger and an admin grantee", async () => {
        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "admin", threadId, userId: "user-admin" }),
        );

        for (const userId of ["user-stranger", "user-admin"]) {
            await expect(harness.withIdentity({ userId } as never).mutation(guestLinks.createGuestLink as never, { threadId } as never)).rejects.toBeDefined();
            await expect(harness.withIdentity({ userId } as never).query(guestLinks.getGuestLink as never, { threadId } as never)).rejects.toBeDefined();
        }

        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });

    it.each([
        ["locked", { lockedAt: NOW }],
        ["archived", { status: "archived" }],
        ["trashed", { deleted: true, deletedAt: NOW }],
        ["temporary", { isTemporary: true }],
    ])("is refused on a %s thread", async (_label, patch) => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, patch));

        await expect(createLink()).rejects.toBeDefined();
        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });

    it("does not silently replace a link whose notes still wait", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "waiting");
        await expect(createLink()).rejects.toBeDefined();
        const { linkToken: newToken } = (await asOwner().mutation(guestLinks.createGuestLink as never, { discardWaiting: true, threadId } as never)) as {
            linkToken: string;
        };

        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect((await hold(linkToken, "old link")).reason).toBe("closed");
        // The old route goes in a job after the write, never inside it; then only the new one is left.
        expect(await rows("shardRoutes")).toHaveLength(2);
        await runRouteDrops();
        expect(await rows("shardRoutes")).toMatchObject([{ key: `guest-link:${await hashGuestToken(newToken)}` }]);
    });
});

describe("a guest message", () => {
    it("is held outside the thread and starts nothing", async () => {
        const { linkToken } = await createLink();
        const threadBefore = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));

        expect(await hold(linkToken, "  please run rm -rf\u{E0061}  ")).toMatchObject({ minted: true, ok: true });
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "held", text: "please run rm -rf", threadId, userId: OWNER }]);
        expect(await rows("messages")).toHaveLength(0);
        expect(harness.scheduler.list()).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId))).toEqual(threadBefore);
    });

    it("is capped in length and in how many wait, and refuses a command or a mention", async () => {
        const { linkToken } = await createLink();

        expect((await hold(linkToken, "x".repeat(GUEST_MESSAGE_MAX_CHARS + 1))).reason).toBe("invalid");
        expect((await hold(linkToken, "/run it")).reason).toBe("unsendable");
        expect((await hold(linkToken, "ping @bob")).reason).toBe("unsendable");

        for (let index = 0; index < GUEST_MAX_HELD_PER_LINK; index += 1) {
            expect((await hold(linkToken, `m${index}`, BROWSER)).ok).toBe(true);
        }

        expect((await hold(linkToken, "one too many", BROWSER)).reason).toBe("full");
    });

    it("limits the bound browser per link, and spends nothing of it on another browser's refused posts", async () => {
        const { linkToken } = await createLink();

        expect((await hold(linkToken, "first")).ok).toBe(true);

        for (let index = 0; index < 40; index += 1) {
            expect((await hold(linkToken, `spam ${index}`, "someone-else")).reason).toBe("other_browser");
        }

        // The rest of the hourly allowance (`guest/message:public`), every post accepted.
        for (let index = 1; index < PER_LINK_ALLOWANCE; index += 1) {
            await settle();
            expect((await hold(linkToken, `m${index}`, BROWSER)).ok).toBe(true);
        }

        await settle();
        expect((await hold(linkToken, "one too many", BROWSER)).reason).toBe("limited");
    });

    it("is refused on a lapsed link", async () => {
        const { linkToken } = await createLink();

        await lapse();

        expect((await hold(linkToken, "late")).reason).toBe("closed");
    });
});

describe("the guest actions", () => {
    const post = async (args: { guestToken?: string; linkToken: string; requestId?: string; text: string }) =>
        (await harness.action(async (ctx: any) => await ctx.runAction(guestLinks.postGuestMessage, args))) as { guestToken?: string };
    const view = async (args: { guestToken: string; linkToken: string }) =>
        await harness.action(async (ctx: any) => await ctx.runAction(guestLinks.getGuestView, args));
    const NAMED = "ab".repeat(32);
    const STRANGER = "cd".repeat(32);

    it("bind the first browser and refuse every other one, minting a token for a name not of the minted shape", async () => {
        await expect(post({ linkToken: "not-a-link", text: "hi" })).rejects.toThrow(NOT_ACTIVE);

        const { linkToken } = await createLink();
        const { guestToken } = await post({ guestToken: "short", linkToken, text: "hello" });

        expect(guestToken).toMatch(MINTED_TOKEN);
        expect(JSON.stringify(await rows("threadGuestLinks"))).not.toContain(guestToken);
        expect(await post({ guestToken, linkToken, text: "again" })).toEqual({});
        await expect(post({ linkToken, text: "me too" })).rejects.toThrow(OTHER_BROWSER);
        await expect(post({ guestToken: STRANGER, linkToken, text: "me too" })).rejects.toThrow(OTHER_BROWSER);

        expect((await view({ guestToken: guestToken!, linkToken }))?.messages).toHaveLength(2);
        expect(await view({ guestToken: STRANGER, linkToken })).toBeNull();
    });

    it("bind one browser and store one note when a first post whose reply was lost is retried", async () => {
        const { linkToken } = await createLink();
        const first = { guestToken: NAMED, linkToken, requestId: "req-00000001", text: "hello" };

        expect(await post(first)).toEqual({ guestToken: NAMED });
        // The reply never arrived: the browser sends the same post again, with the token it named.
        expect(await post(first)).toEqual({});

        expect(await rows("threadGuestMessages")).toHaveLength(1);
        expect(await rows("threadGuestLinks")).toMatchObject([{ guestHash: await hashGuestToken(NAMED) }]);
        expect(JSON.stringify(await rows("threadGuestLinks"))).not.toContain(NAMED);
        expect((await view({ guestToken: NAMED, linkToken }))?.messages).toHaveLength(1);
    });

    it("store a later post once when its request id comes twice, and refuse the id for other text", async () => {
        const { linkToken } = await createLink();

        await post({ guestToken: NAMED, linkToken, text: "first" });
        await post({ guestToken: NAMED, linkToken, requestId: "req-00000002", text: "second" });
        await post({ guestToken: NAMED, linkToken, requestId: "req-00000002", text: "second" });
        await expect(post({ guestToken: NAMED, linkToken, requestId: "req-00000002", text: "edited" })).rejects.toThrow(REUSED_REQUEST);

        expect(await rows("threadGuestMessages")).toHaveLength(2);
    });

    it("refuse another browser that repeats a bound browser's request", async () => {
        const { linkToken } = await createLink();
        const first = { guestToken: NAMED, linkToken, requestId: "req-00000003", text: "hello" };

        await post(first);

        await expect(post({ ...first, guestToken: STRANGER })).rejects.toThrow(OTHER_BROWSER);
        await expect(post({ ...first, guestToken: undefined })).rejects.toThrow(OTHER_BROWSER);
    });

    it("charge the per-link allowance once per accepted post, never for a retry", async () => {
        const { linkToken } = await createLink();
        const retried = { guestToken: NAMED, linkToken, requestId: "req-00000004", text: "once" };

        await post({ guestToken: NAMED, linkToken, text: "first" });
        await post(retried);

        for (let index = 0; index < 10; index += 1) {
            await post(retried);
        }

        // The other accepted posts the hourly allowance has room for, then one past it.
        for (let index = 2; index < PER_LINK_ALLOWANCE; index += 1) {
            await settle();
            await post({ guestToken: NAMED, linkToken, text: `m${index}` });
        }

        await settle();
        await expect(post({ guestToken: NAMED, linkToken, text: "one too many" })).rejects.toThrow(LIMITED);
    });
});

describe("revoking a link", () => {
    it("removes the link, its messages and its route", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "bye");
        await asOwner().mutation(guestLinks.revokeGuestLink as never, { threadId } as never);

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(1);
        await runRouteDrops();
        expect(await rows("shardRoutes")).toHaveLength(0);
        expect((await hold(linkToken, "after")).reason).toBe("closed");
    });
});
