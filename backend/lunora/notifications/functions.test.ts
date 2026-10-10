/**
 * The notification inbox against the in-memory harness: the writer's dedupe and
 * sanitising, the bell's query, read state, ownership and retention.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import schema from "../schema";
import {
    createNotification,
    getNotificationInbox,
    markAllNotificationsRead,
    markNotificationRead,
    NOTIFICATION_RETENTION_MS,
    pruneOldNotifications,
} from "./functions";
import { normalizeNotification, safeNotificationLink } from "./notify";

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

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

const USER = "user-a";
const OTHER = "user-b";

type Harness = ReturnType<typeof lunoraTest>;

let harness: Harness;

const as = (userId: string) => harness.withIdentity({ userId } as never);

interface Inbox {
    items: { _id: string; body?: string; link?: string; read: boolean; title: string; type: string }[];
    unreadCount: number;
}

const inbox = async (userId: string): Promise<Inbox> => (await as(userId).query(getNotificationInbox as never, {} as never)) as Inbox;

const itemsOf = async (userId: string): Promise<Inbox["items"]> => {
    const { items } = await inbox(userId);

    return items;
};

const unreadOf = async (userId: string): Promise<number> => {
    const { unreadCount } = await inbox(userId);

    return unreadCount;
};

/** Internal procedures are unreachable from the harness's RPC boundary; call them the way a writer does. */
const runInternal = async (reference: unknown, args: Record<string, unknown>): Promise<unknown> =>
    await harness.run(async (ctx: any) => await ctx.runMutation(reference, args));

const write = async (args: Record<string, unknown>) => await runInternal(createNotification, { title: "Nightly build", type: "task", userId: USER, ...args });

beforeEach(() => {
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.useRealTimers();
});

describe("writing", () => {
    it("lists a new notification as unread, newest first", async () => {
        // Two writes inside one millisecond share a `createdAt`, and the inbox has
        // no order between equals — it is a tie, not a newer row. Step the clock so
        // the order under test exists.
        vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] });
        await write({ title: "First" });
        vi.setSystemTime(Date.UTC(2026, 0, 1) + 1000);
        await write({ title: "Second" });

        const result = await inbox(USER);

        expect(result.unreadCount).toBe(2);
        expect(result.items.map((item) => item.title)).toEqual(["Second", "First"]);
        expect(result.items.every((item) => !item.read)).toBe(true);
    });

    it("writes one row per dedupe key, however often the writer is redelivered", async () => {
        await write({ dedupeKey: "task:t1:3" });
        await write({ dedupeKey: "task:t1:3" });
        await write({ dedupeKey: "task:t1:4" });

        await expect(itemsOf(USER)).resolves.toHaveLength(2);
    });

    it("writes nothing once the recipient's account deletion is underway", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.insert("gdprRequests", { requestedAt: 1, requestType: "deletion", status: "processing", userEmail: "a@example.com", userId: USER });
        });

        // A late writer (an import finishing after the deletion step ran) must not leave a row behind.
        await expect(write({ title: "Import finished" })).resolves.toBeNull();
        await expect(itemsOf(USER)).resolves.toHaveLength(0);
    });

    it("drops a link that is not an in-app path", async () => {
        await write({ link: "https://evil.example/phish" });

        const [item] = await itemsOf(USER);

        expect(item!.link).toBeUndefined();
    });
});

describe("reading and read state", () => {
    it("shows a user only their own notifications", async () => {
        await write({ userId: OTHER });

        expect(await inbox(USER)).toEqual({ items: [], unreadCount: 0 });
        await expect(unreadOf(OTHER)).resolves.toBe(1);
    });

    it("marks one read, and refuses silently to touch another user's", async () => {
        await write({});
        await write({ userId: OTHER });

        const [mine] = await itemsOf(USER);
        const [theirs] = await itemsOf(OTHER);

        await as(USER).mutation(markNotificationRead as never, { notificationId: mine!._id } as never);
        await as(USER).mutation(markNotificationRead as never, { notificationId: theirs!._id } as never);

        await expect(unreadOf(USER)).resolves.toBe(0);
        await expect(unreadOf(OTHER)).resolves.toBe(1);
    });

    it("marks all read", async () => {
        await write({ title: "One" });
        await write({ title: "Two" });

        await expect(as(USER).mutation(markAllNotificationsRead as never, {} as never)).resolves.toEqual({ hasMore: false });
        await expect(unreadOf(USER)).resolves.toBe(0);
    });
});

describe("retention", () => {
    it("prunes notifications older than 30 days and keeps the rest", async () => {
        vi.useFakeTimers({ now: Date.UTC(2026, 0, 1), toFake: ["Date"] });
        await write({ title: "Old" });
        vi.setSystemTime(Date.UTC(2026, 0, 1) + NOTIFICATION_RETENTION_MS + 60_000);
        await write({ title: "New" });

        await runInternal(pruneOldNotifications, {});

        const items = await itemsOf(USER);

        expect(items.map((item) => item.title)).toEqual(["New"]);
    });
});

describe("normalizeNotification", () => {
    it("clamps text and keeps optional fields absent", () => {
        const row = normalizeNotification({ body: " ".repeat(3), title: "t".repeat(500), type: "eval", userId: USER });

        expect(row.title).toHaveLength(200);
        expect(row).not.toHaveProperty("body");
        expect(row).not.toHaveProperty("link");
    });

    it.each(["/chat/abc", "/tasks", "/dashboard?tab=1"])("accepts the in-app path %s", (link) => {
        expect(safeNotificationLink(link)).toBe(link);
    });

    it.each([
        "https://evil.example",
        "//evil.example",
        String.raw`/\evil.example`,
        // eslint-disable-next-line no-script-url -- the scheme under test
        "javascript:alert(1)",
        "chat/abc",
        "/a\nb",
    ])("refuses %s", (link) => {
        expect(safeNotificationLink(link)).toBeUndefined();
    });
});
