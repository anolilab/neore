/**
 * Phone push registration: tokens (register, move between accounts on one phone,
 * unregister, cap, merge, the session a row records), export and erasure.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { reassignGlobalRows } from "../lib/account-merge";
import schema from "../schema";
import { getNativePushConfig, registerPushDevice, unregisterPushDevice } from "./native-push";
import { collectNotificationsForExport, deleteUserNotifications } from "./gdpr";
import { dropPushDevicesOf, MAX_PUSH_DEVICES_PER_USER, trimPushDevices } from "./push-device-writes";

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

const USER = "user-a";
const OTHER = "user-b";
const PHONE = "ExponentPushToken[phone-a]";
const SECOND_PHONE = "ExponentPushToken[phone-b]";

let harness: ReturnType<typeof lunoraTest>;

/** Each user's live session, the one their calls carry (the JWT's `sid`). */
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

/** The phone rows of `userId`, newest first. */
const devicesOf = async (userId: string): Promise<{ platform: string; sessionId: string; token: string }[]> =>
    await harness.run(async (ctx: any) => {
        const { page } = await ctx.db.pushDevices.findMany({ orderBy: [{ lastSeenAt: "desc" }], where: { userId } });

        return page;
    });

const startSession = async (userId: string, expiresAt = Date.now() + 86_400_000) =>
    (await harness.run(
        async (ctx: any) => await ctx.db.insert("session", { createdAt: 1, expiresAt, token: `t-${userId}-${String(expiresAt)}`, updatedAt: 1, userId }),
    )) as string;

beforeEach(async () => {
    vi.stubEnv("EXPO_ACCESS_TOKEN", "");
    harness = lunoraTest(schema as never);
    sessions = { [OTHER]: await startSession(OTHER), [USER]: await startSession(USER) };
});

afterEach(() => {
    harness.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe("phone push off", () => {
    it("registers nothing and reports push off while the Expo access token is unset", async () => {
        expect(await call(getNativePushConfig, USER, {})).toStrictEqual({ enabled: false });
        expect(await call(registerPushDevice, USER, { platform: "ios", token: PHONE })).toStrictEqual({ registered: false });
        expect(await devicesOf(USER)).toHaveLength(0);
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

        // Tied to the sign-in that registered it.
        expect(await devicesOf(USER)).toMatchObject([{ platform: "ios", sessionId: sessions[USER], token: PHONE }]);
    });

    it("moves the phone to the latest account to register it, so the previous one stops getting its pushes", async () => {
        await call(registerPushDevice, USER, { platform: "android", token: PHONE });
        await call(registerPushDevice, OTHER, { platform: "android", token: PHONE });

        expect(await devicesOf(USER)).toHaveLength(0);
        expect(await devicesOf(OTHER)).toMatchObject([{ sessionId: sessions[OTHER], token: PHONE }]);
    });

    it("gives the phone back to its owner when it registers again, after someone with the token took it", async () => {
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        await call(registerPushDevice, OTHER, { platform: "ios", token: PHONE });
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });

        expect(await devicesOf(OTHER)).toHaveLength(0);
        expect(await devicesOf(USER)).toMatchObject([{ sessionId: sessions[USER], token: PHONE }]);
    });

    it("removes the token on sign-out, and leaves another account's row for it alone", async () => {
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });

        await call(unregisterPushDevice, OTHER, { token: PHONE });
        expect(await devicesOf(USER)).toHaveLength(1);

        await call(unregisterPushDevice, USER, { token: PHONE });
        expect(await devicesOf(USER)).toHaveLength(0);
    });

    it("leaves a newer sign-in's registration alone when an older sign-in's release arrives late", async () => {
        const older = sessions[USER]!;

        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        sessions[USER] = await startSession(USER);
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });

        sessions[USER] = older;
        await call(unregisterPushDevice, USER, { token: PHONE });

        expect(await devicesOf(USER)).toHaveLength(1);
    });

    it("keeps the newest phones past the cap", async () => {
        // Seeded straight into the table: the procedure's rate limit allows fewer calls than the cap.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < MAX_PUSH_DEVICES_PER_USER; index += 1) {
                await ctx.db.insert("pushDevices", {
                    createdAt: index,
                    lastSeenAt: index,
                    platform: "ios",
                    sessionId: sessions[USER]!,
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
                    sessionId: sessions[USER]!,
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

    it("drops a guest's phones on an account merge instead of moving them, through the module's own writes", async () => {
        await call(registerPushDevice, USER, { platform: "ios", token: PHONE });
        await call(registerPushDevice, OTHER, { platform: "android", token: SECOND_PHONE });

        // USER is the guest folding into OTHER: its phone registers again under OTHER's own sign-in.
        await call(reassignGlobalRows, null, { from: USER, to: OTHER });

        const stored = await harness.run(async (ctx: any) => await ctx.db.pushDevices.findMany({ where: {} }));

        expect(stored.page.map((row: { token: string; userId: string }) => [row.token, row.userId])).toStrictEqual([[SECOND_PHONE, OTHER]]);
    });

    it("registers nothing for a call that carries no session", async () => {
        sessions = {};

        expect(await call(registerPushDevice, USER, { platform: "ios", token: PHONE })).toStrictEqual({ registered: false });
        expect(await devicesOf(USER)).toHaveLength(0);
    });
});

describe("pushDevices writes", () => {
    /** A table whose rows another registration refreshes between the read and the delete. */
    const racingDb = (rows: { _id: string; lastSeenAt: number; userId: string }[]) => {
        const deleted: string[] = [];

        return {
            db: {
                delete: vi.fn(async (_table: string, id: string) => {
                    deleted.push(id);
                }),
                pushDevices: {
                    findFirst: vi.fn(async ({ where }: { where: { _id: string } }) => {
                        const row = rows.find((candidate) => candidate._id === where._id)!;

                        // `r0` registered again (seen later), `r1` was taken over by another account.
                        if (row._id === "r0") {
                            return { ...row, lastSeenAt: row.lastSeenAt + 1 };
                        }

                        return row._id === "r1" ? { ...row, userId: OTHER } : row;
                    }),
                    findMany: vi.fn(async () => {
                        return { page: rows };
                    }),
                },
            },
            deleted,
        };
    };

    it("skips a row that registered again or changed owner after the first read", async () => {
        const rows = ["r0", "r1", "r2"].map((id, index) => {
            return { _id: id, lastSeenAt: index, userId: USER };
        });
        const { db, deleted } = racingDb(rows);

        expect(await dropPushDevicesOf(db as never, USER)).toBe(1);
        expect(deleted).toStrictEqual(["r2"]);
    });

    it("trims past the cap without deleting a phone that registered again meanwhile", async () => {
        // Newest first, as the trim reads them: the excess is r0 (refreshed since the read) and r1 (taken over).
        const rows = [
            ...Array.from({ length: MAX_PUSH_DEVICES_PER_USER }, (_, index) => {
                return { _id: `keep-${String(index)}`, lastSeenAt: 100 - index, userId: USER };
            }),
            { _id: "r0", lastSeenAt: 1, userId: USER },
            { _id: "r1", lastSeenAt: 0, userId: USER },
        ];
        const { db, deleted } = racingDb(rows);

        expect(await trimPushDevices(db as never, USER)).toBe(0);
        expect(deleted).toHaveLength(0);
    });
});
