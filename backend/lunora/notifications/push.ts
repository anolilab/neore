/**
 * Web Push through `@lunora/notify` (`ctx.push`, configured in `lunora/notify.ts`):
 * this browser's subscription, and delivering a notification to the user's.
 *
 * A subscription is stored per browser (`endpoint`) in the package's D1 store,
 * keyed by `webPushId(endpoint)` and owned by one user. The push itself is
 * {@link sendPushForNotification}, scheduled by `notify()` — a short job, so it
 * runs on the scheduler, not the jobs queue. `ctx.push.broadcast` encrypts per
 * subscription (the push service sees only ciphertext; `public/push-sw.js`
 * shows it) and prunes a subscription its push service answers 404/410 for.
 */
import { webPushId } from "@lunora/notify";
import { LunoraError, v } from "lunorash/server";

import { internal } from "../_generated/internal";
import { internalAction, internalQuery } from "../_generated/server";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";
import { webPushConfig } from "./push-config";
import { isAllowedPushEndpoint } from "./push-endpoint";
import { pushTitle, pushUrgency } from "./push-text";

/** Browsers one user may register; the one not seen for longest is dropped past this. */
export const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 10;

const BASE64URL_KEY = /^[\w-]+=*$/u;

const vKey = (max: number) => v.string().check((value) => value.length > 0 && value.length <= max && BASE64URL_KEY.test(value), { message: "Invalid key" });

const vEndpoint = v.string().check((value) => value.length <= 2048 && isAllowedPushEndpoint(value), { message: "Unsupported push endpoint" });

const vAnyEndpoint = v.string().check((value) => value.length > 0 && value.length <= 2048, { message: "Invalid endpoint" });

/**
 * `register` refuses an endpoint another user holds with `FORBIDDEN`. Its other
 * `FORBIDDEN` (a private or non-allow-listed host) cannot reach it here:
 * `vEndpoint` admits only the public push services.
 */
const isHeldByAnotherUser = (error: unknown): boolean => error instanceof LunoraError && error.code === "FORBIDDEN";

/** Whether push is available, and the key the browser subscribes with. */
export const getPushConfig = authQuery
    .input({})
    .output(v.object({ publicKey: v.optional(v.string()), subscriptionCount: v.number() }))
    .query(async ({ ctx }) => {
        const vapid = webPushConfig(process.env);
        const devices = await ctx.push.list({ limit: MAX_PUSH_SUBSCRIPTIONS_PER_USER, userId: ctx.user.userId });

        return { subscriptionCount: devices.length, ...(vapid && { publicKey: vapid.vapidPublicKey }) };
    });

/**
 * Registers this browser for the caller. `taken` means another account still
 * holds the endpoint (it never signed out on this browser): the client then
 * drops the browser subscription and registers the fresh endpoint it gets.
 */
export const subscribePush = authMutation
    .use(rateLimit("notifications/push"))
    .input({
        endpoint: vEndpoint,
        keys: v.object({ auth: vKey(64), p256dh: vKey(128) }),
        // Set after a VAPID key rotation: the browser's old subscription, which no send can reach any more.
        replacedEndpoint: v.optional(vAnyEndpoint),
        userAgent: v.optional(v.string().check((value) => value.length <= 500, { message: "User agent too long" })),
    })
    .output(v.object({ taken: v.boolean() }))
    .mutation(async ({ args, ctx }) => {
        if (!webPushConfig(process.env)) {
            throw new LunoraError("BAD_REQUEST", "Push notifications are not configured on this server.");
        }

        const { userId } = ctx.user;

        // Behind the deletion workflow's push step, a new row would survive erasure.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return { taken: false };
        }

        if (args.replacedEndpoint !== undefined) {
            await ctx.push.unregister(webPushId(args.replacedEndpoint), { userId });
        }

        try {
            await ctx.push.register({
                subscription: { endpoint: args.endpoint, keys: args.keys },
                userId,
                ...(args.userAgent !== undefined && { metadata: { userAgent: args.userAgent.slice(0, 200) } }),
            });
        } catch (error) {
            if (isHeldByAnotherUser(error)) {
                return { taken: true };
            }

            throw error;
        }

        // Past the cap, the browser not seen for longest goes. The cap bounds this read.
        const devices = await ctx.push.list({ userId });
        const excess = devices.toSorted((a, b) => a.lastSeenAt - b.lastSeenAt).slice(0, Math.max(0, devices.length - MAX_PUSH_SUBSCRIPTIONS_PER_USER));

        await Promise.all(excess.map(async (device) => await ctx.push.unregister(device.id, { userId })));

        ctx.log.event("notifications.subscribe_push", { pruned: excess.length, taken: false });

        return { taken: false };
    });

export const unsubscribePush = authMutation
    .use(rateLimit("notifications/push"))
    .input({ endpoint: vAnyEndpoint })
    .output(v.null())
    .mutation(async ({ args, ctx }) => {
        // Owner-scoped: another user's row for this endpoint is left alone.
        await ctx.push.unregister(webPushId(args.endpoint), { userId: ctx.user.userId });

        ctx.log.event("notifications.unsubscribe_push", { removed: true });

        return null;
    });

/**
 * Whether the signed-in user holds this browser's subscription. The settings
 * switch reads it: a browser subscribed under another account (or dropped
 * server-side after a 404/410) is not this account's, and shows as off.
 */
export const getPushSubscriptionStatus = authQuery
    .input({ endpoint: vAnyEndpoint })
    .output(v.object({ subscribed: v.boolean() }))
    .query(async ({ args, ctx }) => {
        const devices = await ctx.push.list({ limit: MAX_PUSH_SUBSCRIPTIONS_PER_USER, userId: ctx.user.userId });

        return { subscribed: devices.some((device) => device.endpoint === args.endpoint) };
    });

// ─── Delivery ───────────────────────────────────────────────────────────────

export const loadPushNotification = internalQuery
    .input({ notificationId: v.id("notifications"), userId: v.string() })
    .output(
        v.union(
            v.null(),
            v.object({
                body: v.optional(v.string()),
                link: v.optional(v.string()),
                outcome: v.optional(v.union(v.literal("success"), v.literal("failure"))),
                title: v.string(),
                type: v.string(),
            }),
        ),
    )
    .query(async ({ args, ctx }) => {
        const notification = await ctx.db.get(args.notificationId);

        if (notification?.userId !== args.userId) {
            return null;
        }

        return {
            title: notification.title,
            type: notification.type,
            ...(notification.body !== undefined && { body: notification.body }),
            ...(notification.link !== undefined && { link: notification.link }),
            ...(notification.outcome !== undefined && { outcome: notification.outcome }),
        };
    });

/** Push body cap, well inside the 4 KiB a push service accepts after encryption. */
const PUSH_BODY_MAX = 300;

export const sendPushForNotification = internalAction
    .input({ notificationId: v.id("notifications"), userId: v.string() })
    .output(v.null())
    .action(async ({ args, ctx }) => {
        if (!webPushConfig(process.env)) {
            return null;
        }

        const notification = await ctx.runQuery(internal.notifications.push.loadPushNotification, args);

        if (!notification) {
            return null;
        }

        // `public/push-sw.js` reads `title`/`body` and `data.{link,tag}`.
        const result = await ctx.push.broadcast(
            {
                body: notification.body ? `${notification.title}\n${notification.body}`.slice(0, PUSH_BODY_MAX) : notification.title.slice(0, PUSH_BODY_MAX),
                data: { link: notification.link ?? "/dashboard", tag: args.notificationId },
                title: pushTitle(notification.type, notification.outcome),
                urgency: pushUrgency(notification.type),
            },
            { userId: args.userId },
        );

        ctx.log.event("notifications.push", { delivered: result.sent, failed: result.failed, gone: result.pruned, type: notification.type });

        return null;
    });
