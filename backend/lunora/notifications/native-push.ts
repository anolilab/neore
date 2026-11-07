/**
 * Phone push: the app's Expo push token, and delivering a notification to the
 * phones of its user through Expo's push service.
 *
 * A token is one `pushDevices` row (global, keyed by token) owned by the account
 * signed in on that phone. Registering moves the row to the caller, so a second
 * account signing in on the same phone takes the phone over and the first stops
 * getting pushes on it even if its sign-out never reached the server.
 *
 * What leaves our infrastructure is a generic alert and opaque ids, never a thread
 * or run title: iOS shows the placeholder and its Notification Service Extension
 * replaces it with the real text fetched from `/notifications/push-content`;
 * Android gets a data-only message and the app builds the notification after the
 * same fetch. Sending is {@link deliverToPhones}, called from
 * `sendPushForNotification`; receipts are read {@link RECEIPT_DELAY_MS} later.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { systemDb } from "../lib/rls/scope";
import type { ExpoMessage, ExpoOutcome } from "./expo-push";
import { getExpoReceipts, isDeviceGone, sendExpoMessages } from "./expo-push";
import type { PhonePlatform } from "./native-push-config";
import { expoAccessToken, isPhonePushConfigured } from "./native-push-config";
import { MAX_PUSH_DEVICES_PER_USER, trimPushDevices } from "./push-device-writes";
import { PHONE_PLACEHOLDER_TITLE, phonePlaceholderBody } from "./push-text";

/** Expo push tokens: `ExponentPushToken[…]` (and the newer `ExpoPushToken[…]`). */
const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[\w-]+\]$/u;

const vExpoPushToken = v.string().check((value) => value.length <= 200 && EXPO_PUSH_TOKEN.test(value), { message: "Invalid push token" });

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** Expo advises reading receipts about 15 minutes after the send; it keeps them for a day. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/** A phone that was off this long gets nothing late; matches the Web Push TTL. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

/** Whether this deployment pushes to phones. The app asks for permission only when it does. */
export const getNativePushConfig = authQuery
    .input({})
    .output(v.object({ enabled: v.boolean() }))
    .query(async () => {
        return { enabled: isPhonePushConfigured(process.env) };
    });

/**
 * Registers this phone's Expo push token for the caller. `registered: false`
 * means phone push is off (no access token) or the account is being deleted.
 */
export const registerPushDevice = authMutation
    .use(rateLimit("notifications/push"))
    .input({ platform: vPlatform, token: vExpoPushToken })
    .output(v.object({ registered: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!isPhonePushConfigured(process.env)) {
            return { registered: false };
        }

        const { userId } = ctx.user;

        // Behind the deletion workflow's push step, a new row would survive erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return { registered: false };
        }

        const now = Date.now();
        // The token proves the caller holds the phone; the row may still be the account that signed in on it before.
        // Reading and moving it needs the unguarded database: RLS hides and protects another user's row.
        const database = systemDb(ctx);
        const existing = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

        if (existing) {
            await database.patch("pushDevices", existing._id, { lastSeenAt: now, platform: args.platform, userId });
        } else {
            try {
                await ctx.db.insert("pushDevices", { createdAt: now, lastSeenAt: now, platform: args.platform, token: args.token, userId });
            } catch (error) {
                // Another registration of this phone inserted between the read and the write (`by_token` is unique):
                // take its row over instead, so the phone still has exactly one owner, the latest to register.
                const raced = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token } });

                if (!raced) {
                    throw error;
                }

                await database.patch("pushDevices", raced._id, { lastSeenAt: now, platform: args.platform, userId });
            }
        }

        // A deletion that started between the check above and this write has already run its phone step (or will):
        // ask again, and take back this row, so a phone never outlives the account's erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            const written = await database.pushDevices.findFirst({ consistency: "primary", where: { token: args.token, userId } });

            if (written) {
                await database.delete("pushDevices", written._id);
            }

            return { registered: false };
        }

        // Past the cap, the phones not seen for longest go.
        const pruned = await trimPushDevices(ctx.db, userId);

        ctx.log.event("notifications.register_push_device", {
            moved: existing !== null && existing !== undefined && existing.userId !== userId,
            platform: args.platform,
            pruned,
        });

        return { registered: true };
    });

/** Sign-out: this phone stops getting the caller's pushes. Another account's row for the token is left alone. */
export const unregisterPushDevice = authMutation
    .use(rateLimit("notifications/push"))
    .input({ token: v.string().check((value) => value.length > 0 && value.length <= 200, { message: "Invalid push token" }) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        const row = await ctx.db.pushDevices.findFirst({ consistency: "primary", where: { token: args.token, userId: ctx.user.userId } });

        if (row) {
            await ctx.db.delete("pushDevices", row._id);
        }

        ctx.log.event("notifications.unregister_push_device", { removed: Boolean(row) });

        return null;
    });

// ─── Delivery ───────────────────────────────────────────────────────────────

// Every `pushDevices` read is `consistency: "primary"`: the table is global D1, a replica can lag behind a token that
// just moved to another account, and a stale owner would send one account's pushes to the other's phone.
export const listPushDevicesForUser = internalQuery
    .input({ userId: v.string() })
    .output(v.array(v.object({ id: v.id("pushDevices"), platform: vPlatform, token: v.string() })))
    .query(async ({ args, ctx }) => {
        // The newest phones, at most the cap: an account merge can leave more rows than that until the next trim.
        const { page } = await ctx.db.pushDevices.findMany({
            consistency: "primary",
            limit: MAX_PUSH_DEVICES_PER_USER,
            orderBy: [{ lastSeenAt: "desc" }],
            where: { userId: args.userId },
        });

        return page.map((row) => {
            return { id: row._id, platform: row.platform, token: row.token };
        });
    });

/**
 * Drops the phones Expo reported `DeviceNotRegistered` for; no further push goes to them until the device registers
 * again. Each names the owner the send was for and when it was sent: a row another account took over while the send
 * was out, or one the device registered again since (`lastSeenAt` after the send), belongs to a newer registration
 * and is left alone.
 */
export const recordPushDeliveries = internalMutation
    .input({ gone: v.array(v.object({ id: v.id("pushDevices"), sentAt: v.number(), userId: v.string() })) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (const { id, sentAt, userId } of args.gone) {
            const row = await ctx.db.pushDevices.findFirst({ consistency: "primary", where: { _id: id } });

            if (row?.userId === userId && row.lastSeenAt <= sentAt) {
                await ctx.db.delete("pushDevices", id);
            }
        }

        return null;
    });

export interface PhonePushMessage {
    /** The account's language, for the placeholder text. */
    language?: string;
    notificationId: string;
    /** The chat a tap opens, when the notification is about one. */
    threadId?: string;
    urgency: "high" | "normal";
}

/**
 * The message for one phone. iOS: the placeholder alert, `mutableContent` so the Notification Service Extension can
 * replace it. Android: data only, so no text at all leaves us; the app builds the notification itself.
 */
export const phoneMessage = (device: { platform: PhonePlatform; token: string }, message: PhonePushMessage): ExpoMessage => {
    const data = { notificationId: message.notificationId, ...(message.threadId !== undefined && { threadId: message.threadId }) };
    const common = { data, priority: message.urgency, to: device.token, ttl: PUSH_TTL_SECONDS };

    if (device.platform === "android") {
        return common;
    }

    return { ...common, body: phonePlaceholderBody(message.language), mutableContent: true, sound: "default", title: PHONE_PLACEHOLDER_TITLE };
};

const vReceiptEntry = v.object({ deviceId: v.id("pushDevices"), receiptId: v.string(), sentAt: v.number(), userId: v.string() });

/**
 * When a receipt is not there yet (or Expo did not answer), it is asked for again after these delays; Expo keeps
 * receipts for 24 hours, and the last retry lands well inside that.
 */
export const RECEIPT_RETRY_DELAYS_MS: ReadonlyArray<number> = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];

/**
 * Sends one notification to every phone of `userId`, drops the phones Expo calls gone, and schedules the receipt
 * check for the rest. Never throws for a delivery failure: Web Push has already gone out by now.
 */
export const deliverToPhones = async (ctx: ActionCtx, userId: string, message: PhonePushMessage): Promise<void> => {
    const accessToken = expoAccessToken(process.env);

    if (!accessToken) {
        return;
    }

    const devices = await ctx.runQuery(internal.notifications.native_push.listPushDevicesForUser, { userId });

    if (devices.length === 0) {
        return;
    }

    let outcomes: ExpoOutcome[];
    const sentAt = Date.now();

    try {
        outcomes = await sendExpoMessages(
            accessToken,
            devices.map((device) => phoneMessage(device, message)),
        );
    } catch (error) {
        console.warn("[notifications] Phone push send failed:", error);
        ctx.log.event("notifications.native_push", { delivered: 0, failed: devices.length, gone: 0 });

        return;
    }

    const gone: { id: (typeof devices)[number]["id"]; sentAt: number; userId: string }[] = [];
    const receipts: { deviceId: (typeof devices)[number]["id"]; receiptId: string; sentAt: number; userId: string }[] = [];
    let failed = 0;

    for (const [index, outcome] of outcomes.entries()) {
        const device = devices[index]!;

        if (outcome.status === "ok") {
            if (outcome.id !== undefined) {
                receipts.push({ deviceId: device.id, receiptId: outcome.id, sentAt, userId });
            }
        } else if (isDeviceGone(outcome)) {
            gone.push({ id: device.id, sentAt, userId });
        } else {
            failed += 1;
            console.warn(`[notifications] Phone push failed (${device.platform}): ${outcome.error ?? outcome.message}`);
        }
    }

    if (gone.length > 0) {
        await ctx.runMutation(internal.notifications.native_push.recordPushDeliveries, { gone });
    }

    if (receipts.length > 0) {
        await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.notifications.native_push.checkPushReceipts, { attempt: 0, entries: receipts });
    }

    ctx.log.event("notifications.native_push", { delivered: receipts.length, failed, gone: gone.length });
};

/**
 * Reads the receipts of a send. Only `DeviceNotRegistered` deletes a phone; any other error is logged and the phone
 * kept (a credential or rate problem is ours, not the phone's). A receipt Expo does not have yet, or a request Expo
 * does not answer, is asked for again on {@link RECEIPT_RETRY_DELAYS_MS}, so a dead phone is still found.
 */
export const checkPushReceipts = internalAction
    .input({ attempt: v.optional(v.number()), entries: v.array(vReceiptEntry) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const accessToken = expoAccessToken(process.env);

        if (!accessToken || args.entries.length === 0) {
            return null;
        }

        const attempt = args.attempt ?? 0;
        let receipts: Awaited<ReturnType<typeof getExpoReceipts>> = {};
        let isAnswered = true;

        try {
            receipts = await getExpoReceipts(
                accessToken,
                args.entries.map((entry) => entry.receiptId),
            );
        } catch (error) {
            isAnswered = false;
            console.warn("[notifications] Phone push receipts could not be read:", error);
        }

        const gone: { id: (typeof args.entries)[number]["deviceId"]; sentAt: number; userId: string }[] = [];
        const pending: (typeof args.entries)[number][] = [];
        let failed = 0;

        for (const entry of args.entries) {
            const receipt = receipts[entry.receiptId];

            if (isDeviceGone(receipt)) {
                gone.push({ id: entry.deviceId, sentAt: entry.sentAt, userId: entry.userId });
            } else if (receipt?.status === "error") {
                failed += 1;
                console.warn(`[notifications] Phone push receipt error: ${receipt.error ?? receipt.message}`);
            } else if (receipt === undefined) {
                pending.push(entry);
            }
        }

        if (gone.length > 0) {
            await ctx.runMutation(internal.notifications.native_push.recordPushDeliveries, { gone });
        }

        const retryDelay = RECEIPT_RETRY_DELAYS_MS[attempt];

        if (pending.length > 0 && retryDelay !== undefined) {
            await ctx.scheduler.runAfter(retryDelay, internal.notifications.native_push.checkPushReceipts, { attempt: attempt + 1, entries: pending });
        }

        ctx.log.event("notifications.native_push_receipts", {
            answered: isAnswered,
            attempt,
            checked: args.entries.length,
            failed,
            gone: gone.length,
            pending: pending.length,
        });

        return null;
    });
