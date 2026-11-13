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
const { claimRow, GUEST_SEND_LEASE_MS, GUEST_SEND_SCOPE } = await import("../lib/claim-once");
const { guestTextPart } = await import("./lib/attached-text");
const { GUEST_MAX_HELD_PER_LINK, GUEST_MAX_ROWS_PER_LINK, GUEST_MESSAGE_MAX_CHARS, GUEST_MESSAGE_REMOVAL_PAGE, hashGuestToken } =
    await import("./lib/guest-link-store");

const OWNER = "user-owner";
const BROWSER = "fresh-browser-token";
const OTHER_BROWSER = /another browser/u;
const NOT_ACTIVE = /not active/u;
const NO_LONGER_WAITING = /no longer waiting/u;
const LOCKED = /chat is locked/u;
const BEING_SENT = /being sent/u;
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
    (await asOwner().mutation(guestLinks.createGuestLink as never, { threadId } as never)) as { expiresAt: number; id: string; linkToken: string };

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
        ["locked", { lockedAt: NOW }, "THREAD_LOCKED"],
        ["archived", { status: "archived" }, "GUEST_LINK_NOT_ALLOWED"],
        ["trashed", { deleted: true, deletedAt: NOW }, "GUEST_LINK_NOT_ALLOWED"],
        ["temporary", { isTemporary: true }, "GUEST_LINK_NOT_ALLOWED"],
        ["host-run", { runner: "host" }, "GUEST_LINK_NOT_ALLOWED"],
    ])("is refused on a %s thread", async (_label, patch, code) => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, patch));

        // A code of its own (a locked chat answers with the lock's), so the owner's panel says why in the app's words.
        await expect(createLink()).rejects.toMatchObject({ data: { code } });
        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });

    it("does not silently replace a link whose notes still wait", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "waiting");
        await expect(createLink()).rejects.toMatchObject({ data: { code: "GUEST_NOTES_WAITING" } });
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

    it("never binds the link token itself as the guest's, so holding the link is not reading the guest's notes", async () => {
        const { linkToken } = await createLink();
        const { guestToken } = await post({ guestToken: linkToken, linkToken, text: "hello" });

        expect(guestToken).toMatch(MINTED_TOKEN);
        expect(guestToken).not.toBe(linkToken);
        expect(await view({ guestToken: linkToken, linkToken })).toBeNull();
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

describe("reviewing a held note", () => {
    const review =
        (name: "dismissHeldGuestMessage" | "sendHeldGuestMessage", userId = OWNER) =>
        async (messageId: string) =>
            await harness.withIdentity({ userId } as never).mutation(guestLinks[name] as never, { messageId } as never);
    const PROCEDURES = ["sendHeldGuestMessage", "dismissHeldGuestMessage"] as const;
    /** The send's fence, or why it could not be taken (`/chat/start` maps each reason to its own code). */
    const takeSend = async (messageId: string) => {
        const claim = (await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.claimGuestNoteSend, { messageId, userId: OWNER }))) as
            | { fence: number }
            | { refused: string };

        return "fence" in claim ? claim.fence : claim.refused;
    };

    const heldNote = async () => {
        const { linkToken } = await createLink();

        return (await hold(linkToken, "please call me back")).messageId!;
    };

    it.each(PROCEDURES)("%s answers a held note whose link has lapsed as an ended link", async (name) => {
        const messageId = await heldNote();

        await harness.run(async (ctx: any) => {
            const note = await ctx.db.get("threadGuestMessages", messageId);

            await ctx.db.patch("threadGuestLinks", note.linkId, { expiresAt: 1 });
        });
        await expect(review(name)(messageId)).rejects.toMatchObject({ data: { code: "GUEST_LINK_ENDED" } });
    });

    it.each(PROCEDURES)("%s is refused to a stranger, an admin grantee, and on a locked chat without its proof", async (name) => {
        const messageId = await heldNote();

        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "admin", threadId, userId: "user-admin" }),
        );
        await expect(review(name, "user-stranger")(messageId)).rejects.toThrow(NO_LONGER_WAITING);
        await expect(review(name, "user-stranger")(messageId)).rejects.toMatchObject({ data: { code: "GUEST_NOTE_GONE" } });
        await expect(review(name, "user-admin")(messageId)).rejects.toThrow(NO_LONGER_WAITING);
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: NOW }));
        await expect(review(name)(messageId)).rejects.toThrow(LOCKED);
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "held" }]);
    });

    it("sends a note once: the stored send marks it sent, after which it is neither sent again nor dismissed", async () => {
        const messageId = await heldNote();

        expect(await review("sendHeldGuestMessage")(messageId)).toEqual({ status: "ready", text: "please call me back", threadId });

        // What `/chat/start` does around its save: take the send, then record the stored message.
        const claimedAt = await takeSend(messageId);

        expect(await takeSend(messageId)).toBe("being-sent");
        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.recordGuestNoteSent, { claimedAt, messageId, savedMessageId: "saved-1" }));

        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "sent" }]);
        expect(await review("sendHeldGuestMessage")(messageId)).toEqual({ status: "sent" });
        expect(await review("dismissHeldGuestMessage")(messageId)).toEqual({ status: "sent" });
    });

    it("frees a note whose send died before storing anything, once the send's lease lapses", async () => {
        const messageId = await heldNote();

        await takeSend(messageId);
        await expect(review("sendHeldGuestMessage")(messageId)).rejects.toThrow(BEING_SENT);
        await expect(review("sendHeldGuestMessage")(messageId)).rejects.toMatchObject({ data: { code: "GUEST_NOTE_BEING_SENT" } });

        vi.setSystemTime(NOW + GUEST_SEND_LEASE_MS + 1);

        expect(await review("sendHeldGuestMessage")(messageId)).toMatchObject({ text: "please call me back" });
        expect(await takeSend(messageId)).toEqual(expect.any(Number));
    });

    /** `[order, stepOrder]` rows written after the send; the first carries the note when `tagged`. */
    const span = (orders: number, steps = 1) => Array.from({ length: orders * steps }, (_unused, index) => [1 + Math.floor(index / steps), index % steps]);

    it.each([
        ["behind more than a page of newer turns", span(130), true],
        ["in its own turn of more than a page of rows", span(1, 130), true],
        ["nowhere within the walk's cap: taken as sent, never freed to be sent twice", span(320), false],
    ] as const)("settles a lapsed send whose message is %s by marking the note sent", async (_label, rowsAfter, tagged) => {
        const messageId = await heldNote();

        await takeSend(messageId);

        const noteRowId = await harness.run(async (ctx: any) => {
            let first: string | undefined;

            for (const [index, [order, stepOrder]] of rowsAfter.entries()) {
                const note = tagged && index === 0;
                const id = await ctx.db.insert("messages", {
                    message: {
                        content: [note ? guestTextPart("please call me back", messageId) : { text: "step", type: "text" }],
                        role: note ? "user" : "assistant",
                    },
                    order,
                    status: "success",
                    stepOrder,
                    text: "",
                    threadId,
                    tool: false,
                    userId: OWNER,
                });

                first ??= id;
            }

            return first;
        });

        vi.setSystemTime(NOW + GUEST_SEND_LEASE_MS + 1);

        expect(await review("sendHeldGuestMessage")(messageId)).toEqual({ status: "sent" });
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "sent" }]);
        // Found, or taken as sent past the walk: the claim records which.
        expect((await harness.run(async (ctx: any) => await claimRow(ctx, GUEST_SEND_SCOPE, messageId)))?.result).toBe(tagged ? noteRowId : "past-scan");
    });

    it("dismisses a held note by deleting it", async () => {
        const messageId = await heldNote();

        await review("dismissHeldGuestMessage")(messageId);

        expect(await rows("threadGuestMessages")).toHaveLength(0);
    });
});

describe("revoking a link", () => {
    it("removes the link, its messages and its route", async () => {
        const { linkToken } = await createLink();

        const { messageId } = await hold(linkToken, "bye");

        await asOwner().mutation(guestLinks.revokeGuestLink as never, { confirmedNotes: [messageId], threadId } as never);

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(1);
        await runRouteDrops();
        expect(await rows("shardRoutes")).toHaveLength(0);
        expect((await hold(linkToken, "after")).reason).toBe("closed");
    });

    it("names the link by its id, so the owner's panel tells it from a later one made in the same millisecond", async () => {
        const made = await createLink();
        const read = (await asOwner().query(guestLinks.getGuestLink as never, { threadId } as never)) as { link: { id: string } | null };

        expect(read.link?.id).toBe(made.id);
        expect(await rows("threadGuestLinks")).toMatchObject([{ _id: made.id }]);
    });

    const revoke = async (confirmedNotes: (string | undefined)[]) =>
        await asOwner().mutation(guestLinks.revokeGuestLink as never, { confirmedNotes, threadId } as never);

    it("never deletes a note left after the owner confirmed: it refuses with the count now waiting", async () => {
        const { linkToken } = await createLink();
        const first = await hold(linkToken, "first");

        // The owner confirmed the one note they saw; a second came in before the revoke arrived.
        await hold(linkToken, "second", BROWSER);
        await expect(revoke([first.messageId])).rejects.toMatchObject({ data: { code: "GUEST_NOTES_WAITING", waiting: 2 } });
        expect(await rows("threadGuestMessages")).toHaveLength(2);
        expect(await rows("threadGuestLinks")).toHaveLength(1);
    });

    it("tells a note from the one the owner saw: one sent meanwhile and a new one left keep the count, but nothing is deleted", async () => {
        const { linkToken } = await createLink();
        const seen = await hold(linkToken, "the note the owner saw");

        // Sent from the owner's phone, and a guest left another: one note still waits, but not the one confirmed.
        await harness.run(async (ctx: any) => await ctx.db.patch("threadGuestMessages", seen.messageId, { status: "sent" }));
        const unseen = await hold(linkToken, "a note the owner never saw", BROWSER);

        await expect(revoke([seen.messageId])).rejects.toMatchObject({ data: { code: "GUEST_NOTES_WAITING", waiting: 1 } });
        expect(await rows("threadGuestMessages")).toHaveLength(2);

        await revoke([unseen.messageId]);

        expect(await rows("threadGuestMessages")).toHaveLength(0);
    });

    it("refuses a revoke that confirms nothing while a note waits", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "waiting");
        await expect(asOwner().mutation(guestLinks.revokeGuestLink as never, { threadId } as never)).rejects.toMatchObject({
            data: { code: "GUEST_NOTES_WAITING", waiting: 1 },
        });
        expect(await rows("threadGuestMessages")).toHaveLength(1);
    });

    it("takes a whole link in the revoke's own transaction, so no later removal deletes a note the check never saw", () => {
        // A link holding more rows than one removal deletes would leave a continuation that a new note could outrun.
        expect(GUEST_MAX_ROWS_PER_LINK).toBeLessThanOrEqual(GUEST_MESSAGE_REMOVAL_PAGE);
    });
});
