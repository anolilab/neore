/**
 * An admin impersonating the owner can neither lock, archive, trash nor delete a chat, nor undo one of those: each would
 * withdraw the chat's guest link and held notes, and the owner never asked for it. Same pattern as the guest-link writes
 * (`guest-links-access.test.ts`). Unlocking for reading stays open, as reads do.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi, registerModule } from "../../test/registered-api";

const registry = vi.hoisted(() => new Map<string, unknown>());

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const { impersonation, sessionFrom } = vi.hoisted(() => {
    // Set while a test acts as an admin impersonating the signed-in user.
    const state = { by: undefined as string | undefined };

    return {
        impersonation: state,
        sessionFrom: async (context: { auth: { userId?: string | null } }) => {
            const { userId } = context.auth;

            return userId
                ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, impersonatedBy: state.by, isAdmin: false, name: userId, userId }
                : null;
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
const chat = await import("./functions");
const guestLinks = await import("./guest-links");
const lock = await import("../agent/thread-lock");
const { hashPasscode, newPasscodeEpoch } = await import("../lib/thread-lock");

const OWNER = "user-owner";
// Any string the passcode rules accept (6 to 200 characters).
const CODE = "six-or-more";
const IMPERSONATING = /while impersonating/u;

let harness: ReturnType<typeof lunoraTest>;
let openId: string;
let lockedId: string;

const asOwner = () => harness.withIdentity({ userId: OWNER } as never);
const rows = async (table: string) => await harness.run(async (ctx: any) => await ctx.db.query(table).collect());
const thread = async (id: string) => await harness.run(async (ctx: any) => await ctx.db.get("threads", id));
const passcodeRow = async () => ((await rows("threadPasscodes")) as { epoch: string; threadId: string }[]).find((row) => row.threadId === lockedId);

beforeAll(async () => {
    registerModule(registry, "chat_functions", chat);
    registerModule(registry, "chat_guest_links", guestLinks);
    registerModule(registry, "agent_thread_lock", lock);
    registerModule(registry, "agent_threads", await import("../agent/threads"));
    registerModule(registry, "lib_document_history", await import("../lib/document-history"));
}, 60_000);

beforeEach(async () => {
    process.env.STORAGE_SIGNING_SECRET = "p".repeat(40);
    harness = lunoraTest(schema as never);
    openId = (await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "active", title: "Open", userId: OWNER }))) as string;
    lockedId = (await harness.run(
        async (ctx: any) => await ctx.db.insert("threads", { lockedAt: 1, status: "active", title: "Locked", userId: OWNER }),
    )) as string;

    const hashed = await hashPasscode(CODE, 1000);

    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("threadPasscodes", {
                createdAt: 1,
                epoch: newPasscodeEpoch(),
                failedAttempts: 0,
                hash: hashed.hash,
                iterations: hashed.iterations,
                salt: hashed.salt,
                threadId: lockedId,
                updatedAt: 1,
                userId: OWNER,
            }),
    );
    // The open chat has a live guest link: every refused action below would have withdrawn it.
    await asOwner().mutation(guestLinks.createGuestLink as never, { threadId: openId } as never);
});

afterEach(() => {
    impersonation.by = undefined;
    harness.close();
});

/** The open chat as it was set up: active, in no trash, unlocked, its guest link still live. */
const expectOpenChatUntouched = async () => {
    expect(await thread(openId)).toMatchObject({ status: "active" });
    expect(await thread(openId)).not.toHaveProperty("deleted", true);
    expect(await thread(openId)).not.toHaveProperty("lockedAt");
    expect(await rows("threadGuestLinks")).toHaveLength(1);
};

describe("an admin impersonating the owner", () => {
    beforeEach(() => {
        impersonation.by = "admin-1";
    });

    it("cannot archive or unarchive a chat", async () => {
        await expect(asOwner().action(chat.updateThread as never, { status: "archived", threadId: openId } as never)).rejects.toThrow(IMPERSONATING);
        await expectOpenChatUntouched();

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", openId, { status: "archived" }));
        await expect(asOwner().action(chat.updateThread as never, { status: "active", threadId: openId } as never)).rejects.toThrow(IMPERSONATING);
        expect(await thread(openId)).toMatchObject({ status: "archived" });
    });

    it("cannot move a chat to the trash, nor restore one from it", async () => {
        await expect(asOwner().mutation(chat.softDeleteThread as never, { threadId: openId } as never)).rejects.toThrow(IMPERSONATING);
        await expectOpenChatUntouched();

        await harness.run(async (ctx: any) => await ctx.db.patch("threads", lockedId, { deleted: true, deletedAt: 1 }));
        await expect(asOwner().mutation(chat.undoDeleteThread as never, { threadId: lockedId } as never)).rejects.toThrow(IMPERSONATING);
        expect(await thread(lockedId)).toMatchObject({ deleted: true });
    });

    it("cannot delete a chat, alone or in bulk", async () => {
        await expect(asOwner().mutation(chat.deleteThread as never, { threadId: openId } as never)).rejects.toThrow(IMPERSONATING);
        await expect(asOwner().mutation(chat.deleteThreads as never, { threadIds: [openId, lockedId] } as never)).rejects.toThrow(IMPERSONATING);
        await expectOpenChatUntouched();
        expect(await thread(lockedId)).toBeTruthy();
    });

    it("cannot lock a chat, lock it again, or change or remove its passcode", async () => {
        await expect(asOwner().mutation(lock.enableThreadLock as never, { passcode: CODE, threadId: openId } as never)).rejects.toThrow(IMPERSONATING);
        await expectOpenChatUntouched();

        const before = await passcodeRow();

        await expect(asOwner().mutation(lock.lockThread as never, { threadId: lockedId } as never)).rejects.toThrow(IMPERSONATING);
        await expect(
            asOwner().mutation(lock.changeThreadPasscode as never, { currentPasscode: CODE, newPasscode: "another-six", threadId: lockedId } as never),
        ).rejects.toThrow(IMPERSONATING);
        await expect(asOwner().mutation(lock.removeThreadPasscode as never, { passcode: CODE, threadId: lockedId } as never)).rejects.toThrow(IMPERSONATING);
        expect(await passcodeRow()).toMatchObject({ epoch: before?.epoch });
        expect(await thread(lockedId)).toMatchObject({ lockedAt: 1 });
    });

    it("can still unlock a chat to read it", async () => {
        await expect(asOwner().mutation(lock.unlockThread as never, { passcode: CODE, threadId: lockedId } as never)).resolves.toMatchObject({ ok: true });
    });
});

describe("the owner themselves", () => {
    it("archives, and the archive withdraws the guest link", async () => {
        await asOwner().action(chat.updateThread as never, { status: "archived", threadId: openId } as never);

        expect(await thread(openId)).toMatchObject({ status: "archived" });
        expect(await rows("threadGuestLinks")).toHaveLength(0);
    });

    it("trashes and restores", async () => {
        await asOwner().mutation(chat.softDeleteThread as never, { threadId: openId } as never);
        expect(await thread(openId)).toMatchObject({ deleted: true });

        await asOwner().mutation(chat.undoDeleteThread as never, { threadId: openId } as never);
        expect(await thread(openId)).not.toHaveProperty("deleted", true);
    });

    it("locks again", async () => {
        await expect(asOwner().mutation(lock.lockThread as never, { threadId: lockedId } as never)).resolves.toMatchObject({ ok: true });
    });
});
