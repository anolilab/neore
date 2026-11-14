/**
 * Phone push delivery: one notification to every registered phone of its user, through Expo's push service.
 *
 * What leaves our infrastructure is a generic alert and opaque ids, never a thread or run title: every phone shows
 * the localised placeholder (`push-text.ts`), with only `notificationId`/`threadId` as data. A phone is sent to only
 * while the sign-in that registered it lives (`native-push.ts`). `notify()` schedules {@link sendPhonePush}, which
 * sends through {@link deliverToPhones}; receipts are read {@link RECEIPT_DELAY_MS} later ({@link checkPushReceipts}).
 */
import { v } from "lunorash/server";

import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/internal";
import type { ActionCtx } from "../_generated/server";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import type { ExpoMessage, ExpoOutcome } from "./expo-push";
import { getExpoReceipts, isDeviceGone, sendExpoMessages } from "./expo-push";
import type { PhonePlatform } from "./native-push-config";
import { expoAccessToken } from "./native-push-config";
import { MAX_PUSH_DEVICES_PER_USER } from "./push-device-writes";
import { threadIdOfLink } from "./locked-link";
import { approvalToolFallback, PHONE_PLACEHOLDER_TITLE, phonePlaceholderBody, pushUrgency } from "./push-text";

const vPlatform = v.union(v.literal("android"), v.literal("ios"));

/** Expo advises reading receipts about 15 minutes after the send; it keeps them for a day. */
export const RECEIPT_DELAY_MS = 15 * 60 * 1000;

/**
 * When a receipt is not there yet (or Expo did not answer), it is asked for again after these delays; the last retry
 * lands well inside the 24 hours Expo keeps receipts.
 */
export const RECEIPT_RETRY_DELAYS_MS: ReadonlyArray<number> = [30 * 60 * 1000, 2 * 60 * 60 * 1000, 6 * 60 * 60 * 1000];

const vReceiptEntry = v.object({ deviceId: v.id("pushDevices"), receiptId: v.string(), sentAt: v.number(), sessionId: v.string(), userId: v.string() });

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
            live: v.array(
                v.object({ id: v.id("pushDevices"), language: v.optional(v.string()), platform: vPlatform, sessionId: v.string(), token: v.string() }),
            ),
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
        const live: { id: (typeof page)[number]["_id"]; language?: string; platform: (typeof page)[number]["platform"]; sessionId: string; token: string }[] =
            [];

        for (const row of page) {
            const session = await ctx.db.session.findFirst({ consistency: "primary", where: { _id: row.sessionId as Id<"session"> } });

            if (session?.userId === args.userId && session.expiresAt > now) {
                live.push({
                    id: row._id,
                    platform: row.platform,
                    sessionId: row.sessionId,
                    token: row.token,
                    ...(row.language !== undefined && { language: row.language }),
                });
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

/** The phone's action set for a tool approval: approve and deny, answered on the phone through the chat's own approval path. */
export const TOOL_APPROVAL_CATEGORY = "tool_approval";

/** Longest tool name a lock screen shows; a longer one is cut. */
const APPROVAL_TITLE_MAX = 100;

export interface PhonePushMessage {
    /**
     * A tool approval still pending on its chat. The lock screen shows the tool's name and the teammate's name, and nothing
     * else of the request: never its arguments.
     */
    approval?: { approvalId: string; teammate: string; tool: string | null };
    notificationId: string;
    /** The chat a tap opens, when the notification is about one. */
    threadId?: string;
    urgency: "high" | "normal";
}

/**
 * The message for one phone: the same generic alert on both platforms, in the phone's language. Nothing about the
 * notification itself leaves us, only its ids in `data`. A tool approval is the one exception: its alert names the tool
 * and the teammate, and carries the approval's id for the phone's approve and deny actions.
 */
export const phoneMessage = (device: { language?: string; platform: PhonePlatform; token: string }, message: PhonePushMessage): ExpoMessage => {
    const data = {
        notificationId: message.notificationId,
        ...(message.threadId !== undefined && { threadId: message.threadId }),
        ...(message.approval && { approvalId: message.approval.approvalId }),
    };

    if (message.approval) {
        return {
            body: message.approval.teammate,
            categoryId: TOOL_APPROVAL_CATEGORY,
            data,
            priority: message.urgency,
            sound: "default",
            // A call whose name cannot be read back is titled in the phone's own language, as the generic alert is.
            title: (message.approval.tool ?? approvalToolFallback(device.language)).slice(0, APPROVAL_TITLE_MAX),
            to: device.token,
            ttl: PUSH_TTL_SECONDS,
        };
    }

    return {
        body: phonePlaceholderBody(device.language),
        data,
        priority: message.urgency,
        sound: "default",
        ...(device.platform === "ios" && { mutableContent: true }),
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
    const receipts: { deviceId: (typeof devices)[number]["id"]; receiptId: string; sentAt: number; sessionId: string; userId: string }[] = [];
    let delivered = 0;
    let failed = 0;

    for (const [index, outcome] of outcomes.entries()) {
        const device = devices[index]!;

        if (outcome.status === "ok") {
            delivered += 1;

            // A ticket without an id has no receipt to read; the phone is checked again on its next send.
            if (outcome.id !== undefined) {
                receipts.push({ deviceId: device.id, receiptId: outcome.id, sentAt, sessionId: device.sessionId, userId });
            }
        } else if (isDeviceGone(outcome)) {
            gone.push({ id: device.id, sentAt, sessionId: device.sessionId, userId });
        } else {
            failed += 1;
            // The error code only: Expo's message can quote the push token, which stays out of the logs.
            console.warn(`[notifications] Phone push failed (${device.platform}): ${outcome.error ?? "unknown error"}`);
        }
    }

    // Logged first: Expo has answered, and a failed drop below must not lose the record of what it said.
    ctx.log.event("notifications.native_push", { delivered, failed, gone: gone.length });

    if (gone.length > 0) {
        try {
            await ctx.runMutation(internal.notifications.phone_delivery.recordPushDeliveries, { gone });
        } catch (error) {
            // The phone stays until a later send (or its receipt) reports it gone again.
            console.warn("[notifications] Could not drop phones Expo reported gone:", error);
        }
    }

    // A failed schedule must not fail the job after the send: a retry would send the phones the alert again.
    if (receipts.length > 0) {
        try {
            await ctx.scheduler.runAfter(RECEIPT_DELAY_MS, internal.notifications.phone_delivery.checkPushReceipts, { attempt: 0, entries: receipts });
        } catch (error) {
            console.warn("[notifications] Could not schedule the phone push receipt check:", error);
        }
    }
};

/** A sub-agent's approval push waits this long between checks that its run has started waiting on it… */
const SUB_AGENT_WAIT_MS = 30_000;

/** …and is checked this many times (five minutes) before the owner gets the generic alert instead. */
const SUB_AGENT_WAIT_ATTEMPTS = 10;

/**
 * The phone half of a notification's push, its own job beside the browsers' (`push.ts`), so each is retried on its
 * own. Only the ids and the urgency are read from the notification; its title and text never leave here.
 */
export const sendPhonePush = internalAction
    .input({ notificationId: v.id("notifications"), userId: v.string(), waits: v.optional(v.number()) })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        const notification = await ctx.runQuery(internal.notifications.push.loadPushNotification, { notificationId: args.notificationId, userId: args.userId });

        if (!notification) {
            return null;
        }

        const threadId = threadIdOfLink(notification.link);
        let approval: PhonePushMessage["approval"];

        // A tool approval that names its approval gets the approve and deny alert, and only while it is still pending on its
        // chat: an answered one, a locked chat or a foreign one gets no push. Any other notification, including one queued
        // before approvals carried their id, keeps the generic alert.
        if (notification.type === "tool_approval" && notification.approvalId !== undefined) {
            if (threadId === undefined) {
                return null;
            }

            // A sub-agent's approval is answerable only once its run waits on it. Its notification is written in the transaction
            // that moves the run to `awaiting` (`recordPendingToolApprovals`), so a push no longer finds the run still working
            // on its own request; the hold stays as a guard for a run seen running beside a pending request, which holds the
            // actionable alert for a later attempt. After the last attempt the owner still gets the generic alert, which names nothing.
            const working = await ctx.runQuery(internal.notifications.phone_content.subAgentStillWorking, {
                approvalId: notification.approvalId,
            });

            if (working && (args.waits ?? 0) < SUB_AGENT_WAIT_ATTEMPTS) {
                await ctx.scheduler.runAfter(SUB_AGENT_WAIT_MS, internal.notifications.phone_delivery.sendPhonePush, {
                    notificationId: args.notificationId,
                    userId: args.userId,
                    waits: (args.waits ?? 0) + 1,
                });

                return null;
            }

            if (working) {
                await deliverToPhones(ctx, args.userId, {
                    notificationId: args.notificationId,
                    urgency: pushUrgency(notification.type),
                    ...(threadId !== undefined && { threadId }),
                });

                return null;
            }

            const found = await ctx.runQuery(internal.notifications.phone_content.loadApprovalForPush, {
                approvalId: notification.approvalId,
                threadId,
                userId: args.userId,
            });

            if (!found) {
                return null;
            }

            // A locked chat still tells the owner a run waits for them, with the generic alert that names nothing.
            if (!("locked" in found)) {
                // The approval the names belong to: the one asked, or a sibling still pending once that one is answered.
                approval = { approvalId: found.approvalId, teammate: found.teammate, tool: found.tool };
            }
        }

        await deliverToPhones(ctx, args.userId, {
            notificationId: args.notificationId,
            urgency: pushUrgency(notification.type),
            ...(approval && { approval }),
            ...(threadId !== undefined && { threadId }),
        });

        return null;
    });

/**
 * Reads the receipts of a send. Only `DeviceNotRegistered` drops a phone (with the same owner, session and last-seen
 * check as a send); any other error is logged by its code and the phone kept (a credential or rate problem is ours,
 * not the phone's). A receipt Expo does not have yet, or a request Expo does not answer, is asked for again on
 * {@link RECEIPT_RETRY_DELAYS_MS}, so a dead phone is still found.
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

        const gone: { id: (typeof args.entries)[number]["deviceId"]; sentAt: number; sessionId: string; userId: string }[] = [];
        const pending: (typeof args.entries)[number][] = [];
        let failed = 0;

        for (const entry of args.entries) {
            const receipt = receipts[entry.receiptId];

            if (isDeviceGone(receipt)) {
                gone.push({ id: entry.deviceId, sentAt: entry.sentAt, sessionId: entry.sessionId, userId: entry.userId });
            } else if (receipt?.status === "error") {
                failed += 1;
                // The error code only: Expo's message can quote the push token, which stays out of the logs.
                console.warn(`[notifications] Phone push receipt error: ${receipt.error ?? "unknown error"}`);
            } else if (receipt === undefined) {
                pending.push(entry);
            }
        }

        ctx.log.event("notifications.native_push_receipts", {
            answered: isAnswered,
            attempt,
            checked: args.entries.length,
            failed,
            gone: gone.length,
            pending: pending.length,
        });

        if (gone.length > 0) {
            // Before the next check is scheduled, so a failed schedule cannot keep a known-dead phone. A failed drop
            // is logged; the phone stays until a later send or receipt reports it gone.
            try {
                await ctx.runMutation(internal.notifications.phone_delivery.recordPushDeliveries, { gone });
            } catch (error) {
                console.warn("[notifications] Could not drop phones a receipt reported gone:", error);
            }
        }

        // Last: if this throws, the scheduler retries the whole check, which reads the receipts again; the drop above
        // is idempotent, and nothing was queued yet.
        const retryDelay = RECEIPT_RETRY_DELAYS_MS[attempt];

        if (pending.length > 0 && retryDelay !== undefined) {
            await ctx.scheduler.runAfter(retryDelay, internal.notifications.phone_delivery.checkPushReceipts, { attempt: attempt + 1, entries: pending });
        }

        return null;
    });
