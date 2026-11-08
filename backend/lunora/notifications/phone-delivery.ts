/**
 * Phone push delivery: one notification to every registered phone of its user, through Expo's push service.
 *
 * What leaves our infrastructure is a generic alert and opaque ids, never a thread or run title: every phone shows
 * the localised placeholder (`push-text.ts`), with only `notificationId`/`threadId` as data. A phone is sent to only
 * while the sign-in that registered it lives (`native-push.ts`). Sending is {@link deliverToPhones}, called from
 * `sendPushForNotification`.
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalMutation, internalQuery } from "../_generated/server";
import type { ExpoMessage, ExpoOutcome } from "./expo-push";
import { isDeviceGone, sendExpoMessages } from "./expo-push";
import type { PhonePlatform } from "./native-push-config";
import { expoAccessToken } from "./native-push-config";
import { MAX_PUSH_DEVICES_PER_USER } from "./push-device-writes";
import { PHONE_PLACEHOLDER_TITLE, phonePlaceholderBody } from "./push-text";

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** A phone that was off this long gets nothing late; matches the Web Push TTL. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;

// ─── Delivery ───────────────────────────────────────────────────────────────

// Every `pushDevices` read is `consistency: "primary"`: the table is global D1, a replica can lag behind a token that
// just moved to another account, and a stale owner would send one account's pushes to the other's phone.
//
// A phone whose session is gone (revoked, signed out elsewhere) or expired is not sent to: the server ended that
// sign-in without the phone's own sign-out, which is what would have released it. It comes back as `ended` and is
// dropped by `recordPushDeliveries`.
export const listPushDevicesForUser = internalQuery
    .input({ userId: v.string() })
    .output(
        v.object({
            ended: v.array(v.object({ id: v.id("pushDevices"), lastSeenAt: v.number(), sessionId: v.string() })),
            live: v.array(v.object({ id: v.id("pushDevices"), platform: vPlatform, sessionId: v.string(), token: v.string() })),
        }),
    )
    .query(async ({ args, ctx }) => {
        // The newest phones, at most the cap (the trim on registration keeps it there).
        const { page } = await ctx.db.pushDevices.findMany({
            consistency: "primary",
            limit: MAX_PUSH_DEVICES_PER_USER,
            orderBy: [{ lastSeenAt: "desc" }],
            where: { userId: args.userId },
        });

        const now = Date.now();
        const ended: { id: (typeof page)[number]["_id"]; lastSeenAt: number; sessionId: string }[] = [];
        const live: { id: (typeof page)[number]["_id"]; platform: (typeof page)[number]["platform"]; sessionId: string; token: string }[] = [];

        for (const row of page) {
            const session = await ctx.db.session.findFirst({ consistency: "primary", where: { _id: row.sessionId as Id<"session"> } });

            if (session?.userId === args.userId && session.expiresAt > now) {
                live.push({ id: row._id, platform: row.platform, sessionId: row.sessionId, token: row.token });
            } else {
                ended.push({ id: row._id, lastSeenAt: row.lastSeenAt, sessionId: row.sessionId });
            }
        }

        return { ended, live };
    });

/**
 * Drops the phones Expo reported `DeviceNotRegistered` for; no further push goes to them until the device registers
 * again. Each names the owner the send was for and when it was sent: a row another account took over while the send
 * was out, or one the device registered again since (`lastSeenAt` after the send), belongs to a newer registration
 * and is left alone.
 */
export const recordPushDeliveries = internalMutation
    .input({ gone: v.array(v.object({ id: v.id("pushDevices"), sentAt: v.number(), sessionId: v.string(), userId: v.string() })) })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        for (const { id, sentAt, sessionId, userId } of args.gone) {
            const row = await ctx.db.pushDevices.findFirst({ consistency: "primary", where: { _id: id } });

            // The same sign-in too: a registration in the same millisecond as the send carries a new session.
            if (row?.userId === userId && row.sessionId === sessionId && row.lastSeenAt <= sentAt) {
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
 * The message for one phone: the same generic alert on both platforms, in the account's language. Nothing about the
 * notification itself leaves us, only its ids in `data`.
 */
export const phoneMessage = (device: { platform: PhonePlatform; token: string }, message: PhonePushMessage): ExpoMessage => {
    const data = { notificationId: message.notificationId, ...(message.threadId !== undefined && { threadId: message.threadId }) };

    return {
        body: phonePlaceholderBody(message.language),
        data,
        priority: message.urgency,
        sound: "default",
        title: PHONE_PLACEHOLDER_TITLE,
        to: device.token,
        ttl: PUSH_TTL_SECONDS,
    };
};

/**
 * Sends one notification to every phone of `userId` and drops the phones Expo calls gone. Never throws for a delivery
 * failure: Web Push has already gone out by now.
 */
export const deliverToPhones = async (ctx: ActionCtx, userId: string, message: PhonePushMessage): Promise<void> => {
    const accessToken = expoAccessToken(process.env);

    if (!accessToken) {
        return;
    }

    const { ended, live: devices } = await ctx.runQuery(internal.notifications.phone_delivery.listPushDevicesForUser, { userId });

    if (ended.length > 0) {
        // Stamped with the row's session and when it was last seen: a phone that registered again since stays. A
        // failed cleanup must not keep the live phones from getting the push; the next send tries again.
        try {
            await ctx.runMutation(internal.notifications.phone_delivery.recordPushDeliveries, {
                gone: ended.map((row) => {
                    return { id: row.id, sentAt: row.lastSeenAt, sessionId: row.sessionId, userId };
                }),
            });
        } catch (error) {
            console.warn("[notifications] Could not drop phones whose session ended:", error);
        }
    }

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

    const gone: { id: (typeof devices)[number]["id"]; sentAt: number; sessionId: string; userId: string }[] = [];
    let delivered = 0;
    let failed = 0;

    for (const [index, outcome] of outcomes.entries()) {
        const device = devices[index]!;

        if (outcome.status === "ok") {
            delivered += 1;
        } else if (isDeviceGone(outcome)) {
            gone.push({ id: device.id, sentAt, sessionId: device.sessionId, userId });
        } else {
            failed += 1;
            console.warn(`[notifications] Phone push failed (${device.platform}): ${outcome.error ?? outcome.message}`);
        }
    }

    if (gone.length > 0) {
        await ctx.runMutation(internal.notifications.phone_delivery.recordPushDeliveries, { gone });
    }

    ctx.log.event("notifications.native_push", { delivered, failed, gone: gone.length });
};
