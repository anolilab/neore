/* eslint-disable unicorn/no-await-expression-member */
/**
 * Guest links: a guest's message is HELD and nothing runs until the owner sends it. The owner procedures run
 * under row-level security as the owner; the guest half is the internal mutation/query the public actions
 * call on the owner's shard. `callOnShard` needs a Durable Object namespace, which the harness lacks, so it
 * runs the call through the harness itself.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";
import { BATCH } from "../gdpr/batch";
import { erasePersistentStreamsForUser } from "./gdpr";

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
const { GUEST_LINK_TTL_MS, GUEST_MAX_HELD_PER_LINK, GUEST_MESSAGE_MAX_CHARS, hashGuestToken } = await import("./lib/guest-link-store");
const { _deletePageForThreadId, markThreadArchived } = await import("../agent/threads");

const OWNER = "user-owner";
const STRANGER = "user-stranger";

let harness: ReturnType<typeof lunoraTest>;
let threadId: string;

const asOwner = () => harness.withIdentity({ userId: OWNER } as never);

const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());

/** `/chat/start` saved the note into the chat: the server marks it taken. */
const takeNote = async (messageId: string) =>
    await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.markGuestNoteSent, { messageId, userId: OWNER }));

const createLink = async () =>
    (await asOwner().mutation(guestLinks.createGuestLink as never, { threadId } as never)) as { expiresAt: number; linkToken: string };

const hold = async (linkToken: string, text: string, guestToken?: string) => {
    const linkHash = await hashGuestToken(linkToken);

    return (await harness.run(
        async (ctx: any) =>
            await ctx.runMutation(guestLinks.holdGuestMessage, {
                freshGuestHash: await hashGuestToken("fresh-browser-token"),
                linkHash,
                presentedGuestHash: guestToken === undefined ? undefined : await hashGuestToken(guestToken),
                text,
            }),
    )) as { messageId?: string; minted?: boolean; ok: boolean; reason?: string };
};

beforeAll(async () => {
    registerModule(registry, "chat_guest_links", guestLinks);
}, 60_000);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    shard.harness = harness as never;
    threadId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "T", userId: OWNER }))) as string;
});

afterEach(() => {
    harness.close();
});

describe("creating a link", () => {
    it("stores only hashes, routes the link to the owner and lasts 24 hours", async () => {
        const { expiresAt, linkToken } = await createLink();

        expect(expiresAt - Date.now()).toBeLessThanOrEqual(GUEST_LINK_TTL_MS);
        expect(expiresAt - Date.now()).toBeGreaterThan(GUEST_LINK_TTL_MS - 60_000);

        const [link] = (await rows("threadGuestLinks")) as [{ linkHash: string; userId: string }];

        expect(link.linkHash).toBe(await hashGuestToken(linkToken));
        expect(JSON.stringify(await rows("threadGuestLinks"))).not.toContain(linkToken);
        expect(await rows("shardRoutes")).toMatchObject([{ key: `guest-link:${link.linkHash}`, ownerId: OWNER }]);
    });

    it("refuses anyone but the owner, and replaces the earlier link", async () => {
        await expect(
            harness.withIdentity({ userId: STRANGER } as never).mutation(guestLinks.createGuestLink as never, { threadId } as never),
        ).rejects.toBeDefined();

        const first = await createLink();
        const second = await createLink();

        expect(await rows("threadGuestLinks")).toHaveLength(1);
        expect((await hold(first.linkToken, "hello")).reason).toBe("closed");
        expect((await hold(second.linkToken, "hello")).ok).toBe(true);
    });
});

describe("a guest message", () => {
    it("is held, binds the browser, and starts nothing", async () => {
        const { linkToken } = await createLink();
        const threadBefore = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId));
        const result = await hold(linkToken, "  please run rm -rf  ");

        expect(result).toMatchObject({ minted: true, ok: true });
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "held", text: "please run rm -rf", threadId, userId: OWNER }]);
        // Not a thread message, so no agent context, title or summary can read it; the thread row is untouched.
        expect(await rows("messages")).toHaveLength(0);
        expect(await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId))).toEqual(threadBefore);
    });

    it("answers a stranger's browser with a refusal and the bound browser with success", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "one");

        expect((await hold(linkToken, "two")).reason).toBe("other_browser");
        expect((await hold(linkToken, "two", "some-other-token")).reason).toBe("other_browser");
        expect(await hold(linkToken, "two", "fresh-browser-token")).toMatchObject({ minted: false, ok: true });
        expect(await rows("threadGuestMessages")).toHaveLength(2);
    });

    it("spends the link's allowance only for the bound browser, never for a stranger's refused posts", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "first");

        for (let index = 0; index < 40; index += 1) {
            expect((await hold(linkToken, `spam ${index}`, "someone-else")).reason).toBe("other_browser");
        }

        expect((await hold(linkToken, "still me", "fresh-browser-token")).ok).toBe(true);
    });

    it("is limited per link once the bound browser has used its allowance", async () => {
        const { linkToken } = await createLink();
        // Taken up, so the held cap does not end the run first.
        const markSent = async () =>
            await harness.run(async (ctx: any) => {
                const held = await ctx.db.query("threadGuestMessages").collect();

                for (const row of held) {
                    await ctx.db.patch("threadGuestMessages", row._id, { status: "sent" });
                }
            });

        await hold(linkToken, "first");

        let outcome = { ok: true } as { ok: boolean; reason?: string };

        for (let index = 0; index < 40 && outcome.ok; index += 1) {
            await markSent();
            outcome = await hold(linkToken, `m${index}`, "fresh-browser-token");
        }

        expect(outcome.reason).toBe("limited");
    });

    it("is capped in length and in how many wait for the owner", async () => {
        const { linkToken } = await createLink();

        expect((await hold(linkToken, "x".repeat(GUEST_MESSAGE_MAX_CHARS + 1))).reason).toBe("invalid");
        expect((await hold(linkToken, " ".repeat(3))).reason).toBe("invalid");

        await hold(linkToken, "first");

        for (let index = 1; index < GUEST_MAX_HELD_PER_LINK; index += 1) {
            expect((await hold(linkToken, `m${index}`, "fresh-browser-token")).ok).toBe(true);
        }

        expect((await hold(linkToken, "one too many", "fresh-browser-token")).reason).toBe("full");
    });

    it("is refused on a lapsed link, an archived thread and an unknown link", async () => {
        const { linkToken } = await createLink();

        expect((await hold("not-a-link", "hi")).reason).toBe("closed");

        await harness.run(async (ctx: any) => {
            const [link] = await ctx.db.query("threadGuestLinks").collect();

            await ctx.db.patch("threadGuestLinks", link._id, { expiresAt: Date.now() - 1 });
        });
        expect((await hold(linkToken, "late")).reason).toBe("closed");
    });
});

describe("the owner", () => {
    it("sees what waits, sends it (marking it taken up) and dismisses it", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "first");
        await hold(linkToken, "second", "fresh-browser-token");

        const listed = (await asOwner().query(guestLinks.getGuestLink as never, { threadId } as never)) as {
            link: { bound: boolean } | null;
            messages: { id: string; status: string; text: string }[];
        };

        expect(listed.link).toMatchObject({ bound: true });
        // Both notes can share a creation time, so the list has no order between them: each is found by its text.
        expect(listed.messages.map((message) => message.text).toSorted((a, b) => a.localeCompare(b))).toEqual(["first", "second"]);

        const first = listed.messages.find((message) => message.text === "first")!;
        const second = listed.messages.find((message) => message.text === "second")!;

        expect(await asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId: first.id } as never)).toEqual({ text: "first", threadId });
        // Handing the text out is not the send: until the client confirms, the message stays held.
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "held" }, { status: "held" }]);
        // A retry after a failed client send returns it again.
        expect(await asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId: first.id } as never)).toMatchObject({ text: "first" });
        // A confirmation before the text is in the chat is refused.
        await expect(asOwner().mutation(guestLinks.confirmGuestMessageSent as never, { messageId: first.id } as never)).rejects.toBeDefined();
        await takeNote(first.id);
        // Confirmed once more (a retried confirm) changes nothing; handing it out again is refused, so it is not sent twice.
        await asOwner().mutation(guestLinks.confirmGuestMessageSent as never, { messageId: first.id } as never);
        await expect(asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId: first.id } as never)).rejects.toBeDefined();
        await asOwner().mutation(guestLinks.dismissHeldGuestMessage as never, { messageId: second.id } as never);

        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "sent", text: "first" }]);
        // Sending hands text to the owner's client; the backend wrote no thread message and ran nothing.
        expect(await rows("messages")).toHaveLength(0);
    });

    it("cannot dismiss a message that was already sent, so the guest keeps what was said", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "sent one");

        const message = (await rows("threadGuestMessages"))[0] as { _id: string };

        await asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId: message._id } as never);
        await takeNote(message._id);

        await expect(asOwner().mutation(guestLinks.dismissHeldGuestMessage as never, { messageId: message._id } as never)).rejects.toBeDefined();
        expect(await rows("threadGuestMessages")).toHaveLength(1);
    });

    it("cannot dismiss a held message on a locked chat without the unlock proof", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "waiting");

        const [message] = (await rows("threadGuestMessages")) as ({ _id: string } | undefined)[];

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId, { lockedAt: Date.now() }));

        await expect(asOwner().mutation(guestLinks.dismissHeldGuestMessage as never, { messageId: message?._id } as never)).rejects.toBeDefined();
        expect(await rows("threadGuestMessages")).toHaveLength(1);
    });

    it("cannot be impersonated: another user can neither list, send nor dismiss", async () => {
        const { linkToken } = await createLink();
        const { messageId } = await hold(linkToken, "private");
        const stranger = harness.withIdentity({ userId: STRANGER } as never);

        await expect(stranger.query(guestLinks.getGuestLink as never, { threadId } as never)).rejects.toBeDefined();
        await expect(stranger.mutation(guestLinks.sendHeldGuestMessage as never, { messageId } as never)).rejects.toBeDefined();
        await expect(stranger.mutation(guestLinks.confirmGuestMessageSent as never, { messageId } as never)).rejects.toBeDefined();
        await expect(stranger.mutation(guestLinks.dismissHeldGuestMessage as never, { messageId } as never)).rejects.toBeDefined();
        expect(await rows("threadGuestMessages")).toMatchObject([{ status: "held" }]);
    });

    it("revokes the link with its messages and route", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "bye");
        await asOwner().mutation(guestLinks.revokeGuestLink as never, { threadId } as never);

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
        expect((await hold(linkToken, "after")).reason).toBe("closed");
    });

    it("loses the link, its messages and its route when the thread is archived", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "bye");
        await harness.run(async (ctx: any) => await markThreadArchived({ ...ctx, now: Date.now() }, threadId as never));

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });

    it("loses the link, its messages and its route when the thread is deleted, on the one-page delete too", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "bye");
        await harness.run(async (ctx: any) => await ctx.runMutation(_deletePageForThreadId, { threadId }));

        expect(await rows("threads")).toHaveLength(0);
        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(0);
    });

    it("puts the owner's shard in the housekeeping census, so the lapsed link is swept", async () => {
        // A fresh owner: the census write is throttled per shard for the life of the module.
        const owner = "user-dormant-owner";
        const thread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "D", userId: owner }))) as string;

        await harness.withIdentity({ userId: owner } as never).mutation(guestLinks.createGuestLink as never, { threadId: thread } as never);

        expect(await rows("shardActivity")).toMatchObject([{ shardKey: owner }]);
    });
});

describe("the guest's view", () => {
    it("shows only the bound browser its own messages and their status", async () => {
        const { linkToken } = await createLink();
        const linkHash = await hashGuestToken(linkToken);
        const { messageId } = await hold(linkToken, "mine");
        const view = async (guestToken: string) =>
            await harness.run(async (ctx: any) => await ctx.runQuery(guestLinks.readGuestView, { guestHash: await hashGuestToken(guestToken), linkHash }));

        expect(await view("fresh-browser-token")).toMatchObject({ messages: [{ status: "held", text: "mine" }] });
        expect(await view("someone-else")).toBeNull();

        await asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId } as never);

        expect(await view("fresh-browser-token")).toMatchObject({ messages: [{ status: "held", text: "mine" }] });

        await takeNote(messageId as string);

        expect(await view("fresh-browser-token")).toMatchObject({ messages: [{ status: "sent", text: "mine" }] });
    });
});

const NOT_ACTIVE = /not active/u;
const OTHER_BROWSER = /another browser/u;

/** The shape `newGuestToken` mints. */
const MINTED_TOKEN = /^[0-9a-f]{64}$/u;

const REUSED_REQUEST = /already used for a different message/u;

describe("the guest actions", () => {
    const post = async (args: { guestToken?: string; linkToken: string; requestId?: string; text: string }) =>
        (await harness.action(async (ctx: any) => await ctx.runAction(guestLinks.postGuestMessage, args))) as { guestToken?: string };
    const view = async (args: { guestToken: string; linkToken: string }) =>
        await harness.action(async (ctx: any) => await ctx.runAction(guestLinks.getGuestView, args));

    it("binds the link to a token the browser named before its first post, so a lost reply can be retried with it", async () => {
        const { linkToken } = await createLink();
        const named = "ab".repeat(32);

        expect(await post({ guestToken: named, linkToken, text: "first" })).toEqual({ guestToken: named });
        expect(await post({ guestToken: named, linkToken, text: "retried" })).toEqual({});
        await expect(post({ guestToken: "cd".repeat(32), linkToken, text: "other" })).rejects.toThrow(OTHER_BROWSER);
    });

    it("writes one note when the same post is retried after a lost reply", async () => {
        const { linkToken } = await createLink();
        const request = { guestToken: "ab".repeat(32), linkToken, requestId: "req-00000001", text: "once" };

        await post(request);
        expect(await post(request)).toEqual({});
        expect(await rows("threadGuestMessages")).toHaveLength(1);
    });

    it("refuses a request id reused for different text, so one id never writes two notes", async () => {
        const { linkToken } = await createLink();
        const request = { guestToken: "ab".repeat(32), linkToken, requestId: "req-00000002", text: "once" };

        await post(request);
        await expect(post({ ...request, text: "edited" })).rejects.toThrow(REUSED_REQUEST);
        expect(await rows("threadGuestMessages")).toHaveLength(1);
    });

    it("mints a token when the one named is not of the minted shape", async () => {
        const { linkToken } = await createLink();
        const minted = await post({ guestToken: "short", linkToken, text: "first" });

        expect(minted.guestToken).toMatch(MINTED_TOKEN);
    });

    it("route a post to the owner, bind the first browser and refuse every other one", async () => {
        await expect(post({ linkToken: "not-a-link", text: "hi" })).rejects.toThrow(NOT_ACTIVE);

        const { linkToken } = await createLink();
        const first = await post({ linkToken, text: "hello" });

        expect(first.guestToken).toEqual(expect.any(String));
        expect(await post({ guestToken: first.guestToken, linkToken, text: "again" })).toEqual({});
        await expect(post({ linkToken, text: "me too" })).rejects.toThrow(OTHER_BROWSER);
        await expect(post({ guestToken: "made-up", linkToken, text: "me too" })).rejects.toThrow(OTHER_BROWSER);

        const seen = await view({ guestToken: first.guestToken!, linkToken });
        const notes = seen?.messages.map(({ status, text }: { status: string; text: string }) => {
            return { status, text };
        });

        expect(notes).toHaveLength(2);
        expect(notes).toEqual(
            expect.arrayContaining([
                { status: "held", text: "hello" },
                { status: "held", text: "again" },
            ]),
        );
        expect(await view({ guestToken: "made-up", linkToken })).toBeNull();
        expect(await view({ guestToken: first.guestToken!, linkToken: "not-a-link" })).toBeNull();
    });
});

describe("the sweep", () => {
    it("carries on when a full batch of lapsed links may have left more behind", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 51; index += 1) {
                const thread = await ctx.db.insert("threads", { status: "active", title: `L${index}`, userId: OWNER });

                await ctx.db.insert("threadGuestLinks", { createdAt: 0, expiresAt: 1, linkHash: `hash-${index}`, threadId: thread, userId: OWNER });
            }
        });

        // Nothing else in this test schedules anything: every job is the sweep's own continuation.
        const continuations = () => harness.scheduler.list();

        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));

        expect(await rows("threadGuestLinks")).toHaveLength(1);
        expect(continuations()).toHaveLength(1);

        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));

        expect(await rows("threadGuestLinks")).toHaveLength(0);
        expect(continuations()).toHaveLength(1);
    });

    it("removes lapsed links with their messages and routes, keeping live ones", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "old");

        const otherThread = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "U", userId: OWNER }))) as string;
        const live = (await asOwner().mutation(guestLinks.createGuestLink as never, { threadId: otherThread } as never)) as { linkToken: string };

        await harness.run(async (ctx: any) => {
            const link = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            await ctx.db.patch("threadGuestLinks", link._id, { expiresAt: Date.now() - 1 });
        });
        await harness.run(async (ctx: any) => await ctx.runMutation(guestLinks.sweepGuestLinks, {}));

        expect(await rows("threadGuestLinks")).toMatchObject([{ linkHash: await hashGuestToken(live.linkToken) }]);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("shardRoutes")).toHaveLength(1);
    });
});

describe("erasing the account", () => {
    it("removes a link only once no message still references it", async () => {
        await createLink();

        await harness.run(async (ctx: any) => {
            const link = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            for (let index = 0; index < BATCH + 1; index += 1) {
                await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId: link._id, status: "held", text: `m${index}`, threadId, userId: OWNER });
            }
        });

        const first = (await harness.run(async (ctx: any) => await erasePersistentStreamsForUser(ctx, OWNER))) as { hasMore: boolean };

        expect(first.hasMore).toBe(true);
        expect(await rows("threadGuestLinks")).toHaveLength(1);

        const second = (await harness.run(async (ctx: any) => await erasePersistentStreamsForUser(ctx, OWNER))) as { hasMore: boolean };

        expect(second.hasMore).toBe(false);
        expect(await rows("threadGuestMessages")).toHaveLength(0);
        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });
});

describe("the owner's export", () => {
    it("carries the thread's guest notes, held and sent, with their status", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "first");
        await hold(linkToken, "second", "fresh-browser-token");

        const first = ((await rows("threadGuestMessages")) as { _id: string; text: string }[]).find((row) => row.text === "first")!;

        await asOwner().mutation(guestLinks.sendHeldGuestMessage as never, { messageId: first._id } as never);
        await takeNote(first._id);

        const notes = (await harness.run(async (ctx: any) => await ctx.runQuery(guestLinks.listGuestNotesForExport, { threadId }))) as {
            status: string;
            text: string;
        }[];

        expect(
            notes
                .map(({ status, text }) => {
                    return { status, text };
                })
                .toSorted((a, b) => a.text.localeCompare(b.text)),
        ).toEqual([
            { status: "sent", text: "first" },
            { status: "held", text: "second" },
        ]);
    });
});

describe("a held note sent on from a chat", () => {
    it("is looked up only for its owner, and tells the chat it was left in", async () => {
        await createLink();

        const messageId = await harness.run(async (ctx: any) => {
            const link = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            return await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId: link._id, status: "held", text: "a note", threadId, userId: OWNER });
        });

        const own = await harness.run(async (ctx: any) => await ctx.runQuery(guestLinks.getGuestNoteForSend, { messageId, userId: OWNER }));
        const stranger = await harness.run(async (ctx: any) => await ctx.runQuery(guestLinks.getGuestNoteForSend, { messageId, userId: "user-stranger" }));

        expect(own).toEqual({ status: "held", text: "a note", threadId: threadId as string });
        expect(stranger).toBeNull();
    });
});

describe("a held note on a lapsed link", () => {
    it("is not looked up for sending, even before the sweep removes the link", async () => {
        await createLink();

        const messageId = await harness.run(async (ctx: any) => {
            const link = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            await ctx.db.patch("threadGuestLinks", link._id, { expiresAt: 1 });

            return await ctx.db.insert("threadGuestMessages", { createdAt: 0, linkId: link._id, status: "held", text: "late", threadId, userId: OWNER });
        });

        expect(await harness.run(async (ctx: any) => await ctx.runQuery(guestLinks.getGuestNoteForSend, { messageId, userId: OWNER }))).toBeNull();
    });
});

describe("making a new link while notes wait", () => {
    it("is refused until the waiting notes are sent or discarded, and a discard removes them", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "still waiting");

        await expect(asOwner().mutation(guestLinks.createGuestLink as never, { threadId } as never)).rejects.toBeDefined();
        expect(await rows("threadGuestMessages")).toHaveLength(1);

        await asOwner().mutation(guestLinks.createGuestLink as never, { discardWaiting: true, threadId } as never);

        expect(await rows("threadGuestMessages")).toHaveLength(0);
    });
});

describe("a note's text", () => {
    it("has its hidden characters removed, as an ordinary prompt's are", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "hi\u{E0061}");

        expect(await rows("threadGuestMessages")).toMatchObject([{ text: "hi" }]);
    });
});

describe("a new link over a lapsed link", () => {
    it("is not held up by notes on the lapsed link, which the owner cannot see or send", async () => {
        const { linkToken } = await createLink();

        await hold(linkToken, "unseen");
        await harness.run(async (ctx: any) => {
            const link = await ctx.db
                .query("threadGuestLinks")
                .withIndex("by_thread", (q: any) => q.eq("threadId", threadId))
                .first();

            await ctx.db.patch("threadGuestLinks", link._id, { expiresAt: 1 });
        });

        await expect(asOwner().mutation(guestLinks.createGuestLink as never, { threadId } as never)).resolves.toBeDefined();
    });
});
