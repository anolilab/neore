/**
 * Phone push delivery: which phones a send goes to (a live session only), dropping
 * the ones Expo calls gone, the generic message and delivery. Expo's API
 * is mocked; its own suite is `expo-push.test.ts`.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import schema from "../schema";
import { sendExpoMessages } from "./expo-push";
import { registerPushDevice } from "./native-push";
import { deliverToPhones, listPushDevicesForUser, phoneMessage, recordPushDeliveries } from "./phone-delivery";

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

vi.mock("./expo-push", async (importOriginal) => {
    return { ...(await importOriginal<typeof import("./expo-push")>()), sendExpoMessages: vi.fn() };
});

const USER = "user-a";
const OTHER = "user-b";
const PHONE = "ExponentPushToken[phone-a]";
const SECOND_PHONE = "ExponentPushToken[phone-b]";

let harness: ReturnType<typeof lunoraTest>;

/** Each user's live session, the one their calls carry. */
let sessions: Record<string, string>;

type Handler<R> = { handler: (ctx: object, args: Record<string, unknown>) => Promise<R> };

const call = async <R>(procedure: unknown, userId: string | null, args: Record<string, unknown>): Promise<R> =>
    await harness.run(
        async (ctx: object) =>
            await (procedure as Handler<R>).handler(
                { ...ctx, auth: { getIdentity: async () => (userId === null ? null : { sessionId: sessions[userId] }), userId } },
                args,
            ),
    );

type DeviceList = { ended: { id: string; lastSeenAt: number }[]; live: { id: string; platform: string; token: string }[] };

const listOf = async (userId: string) => await call<DeviceList>(listPushDevicesForUser, null, { userId });

/** The phones a send would go to. */
const devicesOf = async (userId: string) => {
    const { live } = await listOf(userId);

    return live;
};

const startSession = async (userId: string, expiresAt = Date.now() + 86_400_000) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("session", { createdAt: 1, expiresAt, token: `t-${userId}-${String(expiresAt)}`, updatedAt: 1, userId }),
    )) as string;

beforeEach(async () => {
    vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
    harness = lunoraTest(schema as never);
    sessions = { [OTHER]: await startSession(OTHER), [USER]: await startSession(USER) };
});

afterEach(() => {
    harness.close();
    vi.unstubAllEnvs();
    vi.mocked(sendExpoMessages).mockReset();
    vi.restoreAllMocks();
});

describe("phone push off", () => {
    it("sends nothing while the Expo access token is unset", async () => {
        vi.stubEnv("EXPO_ACCESS_TOKEN", "");
        const ctx = { log: { event: vi.fn() }, runMutation: vi.fn(), runQuery: vi.fn() };

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", urgency: "high" });

        expect(ctx.runQuery).not.toHaveBeenCalled();
        expect(sendExpoMessages).not.toHaveBeenCalled();
    });
});

describe("the phones a send goes to", () => {
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

    it("stops sending to a phone whose session the server ended or let expire, and reports it to be dropped", async () => {
        const expired = await startSession(USER, Date.now() - 1);

        await harness.run(async (ctx: any) => {
            await ctx.db.insert("pushDevices", { createdAt: 1, lastSeenAt: 1, platform: "ios", sessionId: sessions[USER], token: PHONE, userId: USER });
            await ctx.db.insert("pushDevices", { createdAt: 2, lastSeenAt: 2, platform: "android", sessionId: expired, token: SECOND_PHONE, userId: USER });
        });

        const listed = await listOf(USER);

        expect(listed.live.map((device) => device.token)).toStrictEqual([PHONE]);
        expect(listed.ended).toHaveLength(1);

        // The first phone's session is revoked (signed out elsewhere): its row is gone from the session table.
        await harness.run(async (ctx: any) => {
            await ctx.db.delete("session", sessions[USER]);
        });

        const revoked = await listOf(USER);

        expect(revoked.live).toHaveLength(0);
        expect(revoked.ended).toHaveLength(2);

        await call(recordPushDeliveries, null, {
            gone: revoked.ended.map((row) => {
                return { id: row.id, sentAt: row.lastSeenAt, userId: USER };
            }),
        });

        const { ended } = await listOf(USER);

        expect(ended).toHaveLength(0);
    });
});

describe("phoneMessage", () => {
    it.each(["ios", "android"] as const)("gives a %s phone the generic alert, in the account's language, with only ids as data", (platform) => {
        const message = phoneMessage({ platform, token: PHONE }, { language: "de-DE", notificationId: "n1", threadId: "t1", urgency: "high" });

        expect(message).toStrictEqual({
            body: "Du hast eine neue Benachrichtigung",
            data: { notificationId: "n1", threadId: "t1" },
            priority: "high",
            sound: "default",
            title: "Neore",
            to: PHONE,
            ttl: 86_400,
        });
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
        runQuery: vi.fn(async (): Promise<{ ended: object[]; live: object[] }> => {
            return { ended: [], live: devices };
        }),
    };
};

describe("deliverToPhones", () => {
    beforeEach(() => {
        vi.stubEnv("EXPO_ACCESS_TOKEN", "expo-secret");
        vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    it("drops the phones Expo calls gone at once and keeps a failed one", async () => {
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
            expect.objectContaining({ data: { notificationId: "n1", threadId: "t1" }, title: "Neore", to: PHONE }),
            expect.objectContaining({ data: { notificationId: "n1", threadId: "t1" }, title: "Neore", to: SECOND_PHONE }),
            expect.objectContaining({ to: "ExponentPushToken[c]" }),
        ]);
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.notifications.phone_delivery.recordPushDeliveries, {
            gone: [{ id: "d1", sentAt: expect.any(Number), userId: USER }],
        });
        expect(ctx.log.event).toHaveBeenCalledWith("notifications.native_push", { delivered: 1, failed: 1, gone: 1 });
    });

    it("sends nothing to a phone whose session ended, and has it dropped", async () => {
        const ctx = actionCtx([]);

        ctx.runQuery.mockResolvedValueOnce({ ended: [{ id: "d9", lastSeenAt: 7 }], live: [] });

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", urgency: "normal" });

        expect(sendExpoMessages).not.toHaveBeenCalled();
        expect(ctx.runMutation).toHaveBeenCalledWith(internal.notifications.phone_delivery.recordPushDeliveries, {
            gone: [{ id: "d9", sentAt: 7, userId: USER }],
        });
    });

    it("keeps every phone when Expo cannot be reached", async () => {
        const ctx = actionCtx([{ id: "d1", platform: "ios", token: PHONE }]);

        vi.mocked(sendExpoMessages).mockRejectedValueOnce(new Error("Expo push API answered 503"));

        await deliverToPhones(ctx as never, USER, { notificationId: "n1", urgency: "normal" });

        expect(ctx.runMutation).not.toHaveBeenCalled();
        expect(ctx.log.event).toHaveBeenCalledWith("notifications.native_push", { delivered: 0, failed: 1, gone: 0 });
    });
});
