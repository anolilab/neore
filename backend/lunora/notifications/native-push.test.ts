/**
 * Phone push: tokens (register, move between accounts on one phone, unregister,
 * cap, merge), the generic messages, delivery and receipts, and the content a
 * phone fetches. Expo's API is mocked; its own suite is `expo-push.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { reassignGlobalRows } from "../lib/account-merge";
import schema from "../schema";
import { getExpoReceipts, sendExpoMessages } from "./expo-push";
import {
    checkPushReceipts,
    RECEIPT_RETRY_DELAYS_MS,
    deliverToPhones,
    getNativePushConfig,
    listPushDevicesForUser,
    phoneMessage,
    RECEIPT_DELAY_MS,
    recordPushDeliveries,
    registerPushDevice,
    unregisterPushDevice,
} from "./native-push";
import { collectNotificationsForExport, deleteUserNotifications } from "./gdpr";
import { callOnShard } from "../lib/cross-shard";
import { threadShardFor } from "../lib/thread-shard";
import { loadPhonePushContent, readThreadLockState } from "./push";
import { pushContentHttpAction } from "./push-content-http";
import { MAX_PUSH_DEVICES_PER_USER } from "./push-device-writes";

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    const sessionFrom = async (context: { auth: { userId?: string | null } }) =>
        context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null;

    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../lib/cross-shard", () => {
    return { callOnShard: vi.fn() };
});

vi.mock("../lib/thread-shard", () => {
    return { threadShardFor: vi.fn(async (_context: unknown, userId: string) => userId) };
});

vi.mock("./expo-push", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./expo-push")>()), getExpoReceipts: vi.fn(), sendExpoMessages: vi.fn() };
});

const USER = "user-a";
const OTHER = "user-b";
const PHONE = "ExponentPushToken[phone-a]";
const SECOND_PHONE = "ExponentPushToken[phone-b]";

let harness: ReturnType<typeof lunoraTest>;

type Handler<R> = { handler: (ctx: object, args: Record<string, unknown>) => Promise<R> };

const call = async <R>(procedure: unknown, userId: string | null, args: Record<string, unknown>): Promise<R> =>
    await harness.run(async (ctx: object) => await (procedure as Handler<R>).handler({ ...ctx, auth: { userId } }, args));

const devicesOf = async (userId: string) => await call<{ id: string; platform: string; token: string }[]>(listPushDevicesForUser, null, { userId });

beforeEach(() => {
    vi.stubEnv("EXPO_ACCESS_TOKEN", "");
    harness = lunoraTest(schema as never);
});

afterEach(() => {
    harness.close();
    vi.unstubAllEnvs();
    vi.mocked(sendExpoMessages).mockReset();
    vi.mocked(getExpoReceipts).mockReset();
    vi.restoreAllMocks();
});

describe("phone push off", () => {
    it("registers nothing, reports push off and sends nothing while the Expo access token is unset", async () => {
        const ctx = { log: { event: vi.fn() }, runMutation: vi.fn(), runQuery: vi.fn() };

        expect(await call(getNativePushConfig, USER, {})).toStrictEqual({ enabled: false });
        expect(await call(registerPushDevice, USER, { platform: "ios", token: PHONE })).toStrictEqual({ registered: false });
        expect(await devicesOf(USER)).toHaveLength(0);

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", urgency: "high" });

        expect(ctx.runQuery).not.toHaveBeenCalled();
        expect(sendExpoMessages).not.toHaveBeenCalled();
    });
});

describe("phone push tokens", () => {
    beforeEach(() => {
        vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
    });

    it("stores the token on sign-in, once however often the app registers it", async () => {
        expect(await call(getNativePushConfig, USER, {})).toStrictEqual({ enabled: true });

        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });

        expect(await devicesOf(USER)).toMatchObject([{ platform: "ios", token: PHONE }]);
    });

    it("moves the phone to the account that signed in on it, so the previous one stops getting its pushes", async () => {
        await call(registerPushDevice, USER, { platform: "android", token: PHONE });
        await call(registerPushDevice, OTHER, { platform: "android", token: PHONE });

        expect(await devicesOf(USER)).toHaveLength(0);
        expect(await devicesOf(OTHER)).toMatchObject([{ token: PHONE }]);
    });

    it("removes the token on sign-out, and leaves another account's row for it alone", async () => {
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });

        await call(unregisterPushDevice, OTHER, { token: PHONE });
        expect(await devicesOf(USER)).toHaveLength(1);

        await call(unregisterPushDevice, USER, { token: PHONE });
        expect(await devicesOf(USER)).toHaveLength(0);
    });

    it("keeps the newest phones past the cap", async () => {
        // Seeded straight into the table: the procedure's rate limit allows fewer calls than the cap.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PUSH_DEVICES_PER_USER; index += 1) {
                await ctx.db.insert("pushDevices", {
                    createdAt: index,
                    lastSeenAt: index,
                    platform: "ios",
                    token: `ExponentPushToken[old-${String(index)}]`,
                    userId: USER,
                });
            }
        });

        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        const devices = await devicesOf(USER);
        const tokens = devices.map((device) => device.token);

        expect(tokens).toHaveLength(MAX_PUSH_DEVICES_PER_USER);
        expect(tokens).toContain(PHONE);
        expect(tokens).not.toContain("ExponentPushToken[old-0]");
    });

    it("refuses a token that is not an Expo push token", async () => {
        await expect(call(registerPushDevice, USER, { platform: "ios", token: "f".repeat(64) })).rejects.toThrow();
    });

    it("drops the phones Expo calls gone, and leaves one another account took over while the send was out", async () => {
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        await call(registerPushDevice, USER, { platform: "ios", token: SECOND_PHONE });
        const devices = await devicesOf(USER);
        const first = devices.find((device) => device.token === PHONE)!;
        const second = devices.find((device) => device.token === SECOND_PHONE)!;

        // The send for USER is still out when OTHER signs in on the second phone.
        await call(registerPushDevice, OTHER, { platform: "ios", token: SECOND_PHONE });
        await call(recordPushDeliveries, null, {
            gone: [
                { id: first.id, sentAt: Date.now() + 1000, userId: USER },
                { id: second.id, sentAt: Date.now() + 1000, userId: USER },
            ],
        });

        expect(await devicesOf(USER)).toHaveLength(0);
        expect(await devicesOf(OTHER)).toMatchObject([{ token: SECOND_PHONE }]);
    });

    it("keeps a phone that registered again after the send Expo called it gone for, and stops sending to one that did not", async () => {
        vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });

        try {
            await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
            await call(registerPushDevice, USER, { platform: "ios", token: SECOND_PHONE });
            const devices = await devicesOf(USER);
            const sentAt = Date.now();

            // After the send, the first phone (reinstalled, same token) registers again.
            vi.setSystemTime(2_000_000);
            await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
            await call(recordPushDeliveries, null, {
                gone: devices.map((device) => {
                    return { id: device.id, sentAt, userId: USER };
                }),
            });

            const kept = await devicesOf(USER);

            expect(kept.map((device) => device.token)).toStrictEqual([PHONE]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("never keeps a phone row for an account whose deletion started while the registration was on its way", async () => {
        const guard = await import("../gdpr/deletion-guard");
        // The first check passes; the deletion has begun by the time the row is written.
        const underway = vi.spyOn(guard, "isAccountDeletionUnderway").mockResolvedValueOnce(false).mockResolvedValueOnce(true);

        expect(await call(registerPushDevice, USER, { platform: "ios", token: PHONE })).toStrictEqual({ registered: false });
        expect(underway).toHaveBeenCalledTimes(2);
        expect(await devicesOf(USER)).toHaveLength(0);
    });

    it("exports every phone row, past the first page", async () => {
        // More rows than one page holds, written straight in: the export must page to the end, not stop at the cap.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PUSH_DEVICES_PER_USER * 2 + 3; index += 1) {
                await ctx.db.insert("pushDevices", {
                    createdAt: index,
                    lastSeenAt: index,
                    platform: "ios",
                    token: `ExponentPushToken[p-${String(index)}]`,
                    userId: USER,
                });
            }
        });

        const exported = await harness.run(
            async (ctx: object) =>
                await (collectNotificationsForExport as unknown as Handler<{ pushDevices: unknown[] }>).handler(
                    { ...ctx, auth: { userId: null }, push: { list: async () => [], unregister: async () => undefined } },
                    { userId: USER },
                ),
        );

        expect(exported.pushDevices).toHaveLength(MAX_PUSH_DEVICES_PER_USER * 2 + 3);
    });

    it("erases the phones with the account and exports them without their tokens", async () => {
        await call(registerPushDevice, USER, { platform: "android", token: PHONE });

        // No browser subscriptions here: the GDPR steps read them through `ctx.push`.
        const withPush = async <R>(procedure: unknown, args: Record<string, unknown>): Promise<R> =>
            await harness.run(
                async (ctx: object) =>
                    await (procedure as Handler<R>).handler(
                        { ...ctx, auth: { userId: null }, push: { list: async () => [], unregister: async () => undefined } },
                        args,
                    ),
            );
        const exported = await withPush<{ pushDevices: unknown[] }>(collectNotificationsForExport, { userId: USER });

        expect(exported.pushDevices).toStrictEqual([{ createdAt: expect.any(Number), platform: "android", updatedAt: expect.any(Number) }]);
        expect(JSON.stringify(exported)).not.toContain(PHONE);

        await withPush(deleteUserNotifications, { userId: USER });

        expect(await devicesOf(USER)).toHaveLength(0);
    });

    it("keeps only the newest phones when an account merge brings a second set", async () => {
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PUSH_DEVICES_PER_USER; index += 1) {
                await ctx.db.insert("pushDevices", {
                    createdAt: index,
                    lastSeenAt: index,
                    platform: "ios",
                    token: `ExponentPushToken[old-${String(index)}]`,
                    userId: OTHER,
                });
                await ctx.db.insert("pushDevices", {
                    createdAt: index,
                    lastSeenAt: 100 + index,
                    platform: "android",
                    token: `ExponentPushToken[new-${String(index)}]`,
                    userId: USER,
                });
            }
        });

        // USER is the guest folding into OTHER.
        await call(reassignGlobalRows, null, { from: USER, to: OTHER });
        const kept = await devicesOf(OTHER);
        const stored = await harness.run(async (ctx: any) => await ctx.db.pushDevices.findMany({ where: { userId: OTHER } }));

        expect(kept.every((device) => device.token.includes("new-"))).toBe(true);
        expect(stored.page).toHaveLength(MAX_PUSH_DEVICES_PER_USER);
    });
});

describe("phoneMessage", () => {
    it("gives an iPhone the placeholder alert, in the account's language, with only ids as data", () => {
        const message = phoneMessage({ platform: "ios", token: PHONE }, { language: "de-DE", notificationId: "n1", threadId: "t1", urgency: "high" });

        expect(message).toStrictEqual({
            body: "Du hast eine neue Benachrichtigung",
            data: { notificationId: "n1", threadId: "t1" },
            mutableContent: true,
            priority: "high",
            sound: "default",
            title: "Neore",
            to: PHONE,
            ttl: 86_400,
        });
    });

    it("gives an Android phone a data-only message: no text leaves us at all", () => {
        const message = phoneMessage({ platform: "android", token: PHONE }, { notificationId: "n1", urgency: "normal" });

        expect(message).toStrictEqual({ data: { notificationId: "n1" }, priority: "normal", to: PHONE, ttl: 86_400 });
    });

    it("falls back to English for a language without a placeholder", () => {
        expect(phoneMessage({ platform: "ios", token: PHONE }, { language: "sv", notificationId: "n1", urgency: "high" }).body).toBe(
            "You have a new notification",
        );
    });
});

/** An action ctx whose `runQuery` answers the device list. */
const actionCtx = (devices: object[]) => {
    return {
        log: { event: vi.fn() },
        runMutation: vi.fn(async () => null),
        runQuery: vi.fn(async () => devices),
        scheduler: { runAfter: vi.fn(async () => "job") },
    };
};

describe("deliverToPhones", () => {
    beforeEach(() => {
        vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("drops the phones Expo calls gone at once, keeps a failed one, and checks the receipts of the rest later", async () => {
        const ctx = actionCtx([
            { id: "d1", platform: "ios", token: PHONE },
            { id: "d2", platform: "android", token: SECOND_PHONE },
            { id: "d3", platform: "ios", token: "ExponentPushToken[c]" },
        ]);

        vi.mocked(sendExpoMessages).mockResolvedValueOnce([
            { error: "DeviceNotRegistered", message: "gone", status: "error" },
            { id: "r2", status: "ok" },
            { error: "MessageRateExceeded", message: "slow", status: "error" },
        ]);

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", threadId: "t1", urgency: "high" });

        expect(sendExpoMessages).toHaveBeenCalledWith("expo-secret", [
            expect.objectContaining({ data: { notificationId: "n1", threadId: "t1" }, mutableContent: true, to: PHONE }),
            { data: { notificationId: "n1", threadId: "t1" }, priority: "high", to: SECOND_PHONE, ttl: 86_400 },
            expect.objectContaining({ to: "ExponentPushToken[c]" }),
        ]);
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.notifications.native_push.recordPushDeliveries, {
            gone: [{ id: "d1", sentAt: expect.any(Number), userId: USER }],
        });
        expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(RECEIPT_DELAY_MS, internal.notifications.native_push.checkPushReceipts, {
            attempt: 0,
            entries: [{ deviceId: "d2", receiptId: "r2", sentAt: expect.any(Number), userId: USER }],
        });
        expect(ctx.log.event).toHaveBeenCalledWith("notifications.native_push", { delivered: 1, failed: 1, gone: 1 });
    });

    it("keeps every phone when Expo cannot be reached", async () => {
        const ctx = actionCtx([{ id: "d1", platform: "ios", token: PHONE }]);

        vi.mocked(sendExpoMessages).mockRejectedValueOnce(new Error("Expo push API answered 503"));

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", urgency: "normal" });

        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
        expect(ctx.log.event).toHaveBeenCalledWith("notifications.native_push", { delivered: 0, failed: 1, gone: 0 });
    });
});

describe("checkPushReceipts", () => {
    beforeEach(() => {
        vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    const receiptCtx = () => {
        return { log: { event: vi.fn() }, runMutation: vi.fn(async () => null), scheduler: { runAfter: vi.fn(async () => "job") } };
    };
    const entry = (index: number) => {
        return { deviceId: `d${String(index)}`, receiptId: `r${String(index)}`, sentAt: 5, userId: USER };
    };

    it("deletes a phone only on DeviceNotRegistered; another receipt error keeps it, and one not there yet is asked for again", async () => {
        const ctx = receiptCtx();

        vi.mocked(getExpoReceipts).mockResolvedValueOnce({
            r1: { error: "DeviceNotRegistered", message: "gone", status: "error" },
            r2: { error: "InvalidCredentials", message: "bad key", status: "error" },
            r3: { status: "ok" },
        });

        await (checkPushReceipts as unknown as Handler<null>).handler(ctx, { attempt: 0, entries: [entry(1), entry(2), entry(3), entry(4)] });

        expect(getExpoReceipts).toHaveBeenCalledWith("expo-secret", ["r1", "r2", "r3", "r4"]);
        expect(ctx.runMutation).toHaveBeenCalledTimes(1);
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.notifications.native_push.recordPushDeliveries, {
            gone: [{ id: "d1", sentAt: 5, userId: USER }],
        });
        expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(RECEIPT_RETRY_DELAYS_MS[0], internal.notifications.native_push.checkPushReceipts, {
            attempt: 1,
            entries: [entry(4)],
        });
    });

    it("asks again for every receipt when Expo does not answer, and gives up after the last retry", async () => {
        const ctx = receiptCtx();

        vi.mocked(getExpoReceipts).mockRejectedValue(new Error("Expo push API answered 503"));

        await (checkPushReceipts as unknown as Handler<null>).handler(ctx, { attempt: 1, entries: [entry(1)] });

        expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(RECEIPT_RETRY_DELAYS_MS[1], internal.notifications.native_push.checkPushReceipts, {
            attempt: 2,
            entries: [entry(1)],
        });

        ctx.scheduler.runAfter.mockClear();
        await (checkPushReceipts as unknown as Handler<null>).handler(ctx, { attempt: RECEIPT_RETRY_DELAYS_MS.length, entries: [entry(1)] });

        expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
        expect(ctx.runMutation).not.toHaveBeenCalled();
    });
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
        expect(await call(loadPhonePushContent, null, { notificationId: locked, userId: USER })).toStrictEqual({ generic: true });
    });

    const request = (body: unknown) => new Request("https://api.test/notifications/push-content", { body: JSON.stringify(body), method: "POST" });

    it("answers the HTTP request for the signed-in caller only, the same 404 for any id that is not theirs", async () => {
        const runQuery = vi.fn(async (_reference: unknown, args: { notificationId: string }) =>
            args.notificationId === "mine" ? { body: "b", title: "t" } : null,
        );
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
        expect(runQuery).toHaveBeenLastCalledWith(internal.notifications.push.loadPhonePushContent, { notificationId: "mine", userId: USER });
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
            vi.fn(async (reference: unknown) => (reference === internal.notifications.push.readThreadLockState ? ownState : text));

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
                    internal.notifications.push.readThreadLockState,
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
});
