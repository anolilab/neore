import type { HttpActionCtx, Infer } from "lunorash/server";
import { v } from "lunorash/server";

import { internal } from "../../_generated/internal";
import { MAX_LENGTH } from "../../lib/validators";
import { verifySignedRequest } from "../../lib/sign-request";
import type { NotificationInput } from "../../notifications/notify";
import { MAX_NOTIFICATIONS_PER_BATCH } from "../../notifications/validators";

/** One rule firing, as the gateway's rules engine reports it (`usage/notifications.ts`). */
const vGatewayNotification = v.object({
    action: v.union(v.literal("notify"), v.literal("block"), v.literal("notify_and_block")),
    currentValue: v.number(),
    firedAt: v.optional(v.number()),
    metric: v.string().max(MAX_LENGTH.short),
    ruleId: v.string().max(MAX_LENGTH.id),
    ruleName: v.string().max(MAX_LENGTH.short),
    threshold: v.number(),
});

const vGatewayNotifications = v.object({
    notifications: v.array(vGatewayNotification),
    userId: v.string().max(MAX_LENGTH.id),
});

type GatewayNotification = Infer<typeof vGatewayNotification>;

/** 50 firings at their validators' caps is ~100 KB; anything bigger is not the gateway's. */
const MAX_BODY_BYTES = 256 * 1024;

const MS_PER_HOUR = 3_600_000;

const MICRODOLLARS_PER_DOLLAR = 1_000_000;

const USAGE_LINK = "/dashboard/settings/chat/usage";

/** Cents, except for a positive amount under half a cent, which would read as `$0.00`: that keeps its microdollars. */
const formatDollars = (microdollars: number): string => {
    const dollars = microdollars / MICRODOLLARS_PER_DOLLAR;

    return `$${dollars > 0 && dollars < 0.005 ? String(Number(dollars.toFixed(6))) : dollars.toFixed(2)}`;
};

const describeMetric = (metric: string, value: number): string => {
    switch (metric) {
        case "daily_cost":
        case "monthly_cost": {
            return formatDollars(value);
        }
        case "request_count": {
            return `${Math.round(value)} requests`;
        }
        case "token_count": {
            return `${Math.round(value)} tokens`;
        }
        default: {
            return String(value);
        }
    }
};

/**
 * The inbox row for one firing. The key is the rule plus the instant it fired
 * (the gateway's `firedAt`), not the request's own clock: a re-sent request
 * carries the same `firedAt` and lands on the same key, while the rule's next
 * firing, at least an hour later, never does however late either is delivered.
 * A gateway that predates `firedAt` sends none; its firing is keyed on the hour
 * of the request's signed timestamp (`requestedAt`), as it was before.
 */
export const toUsageAlert = (userId: string, notification: GatewayNotification, requestedAt: number): NotificationInput => {
    const reached = describeMetric(notification.metric, notification.currentValue);
    const limit = describeMetric(notification.metric, notification.threshold);
    const blocked = notification.action === "notify_and_block" ? " Requests are blocked for now." : "";

    const firing = notification.firedAt ?? Math.floor(requestedAt / MS_PER_HOUR);

    return {
        body: `Usage reached ${reached} (limit ${limit}).${blocked}`,
        dedupeKey: `usage_alert:${notification.ruleId}:${firing}`,
        link: USAGE_LINK,
        title: notification.ruleName,
        type: "usage_alert",
        userId,
    };
};

/**
 * HTTP action handler for POST /gateway/notifications.
 * Called by the LLM Gateway when a user's usage rule fires; each firing becomes
 * one inbox notification (`notify()`, idempotent on its dedupe key).
 */
export const gatewayNotificationsHttpAction = async (context: HttpActionCtx, request: Request): Promise<Response> => {
    const secret = process.env.LLM_GATEWAY_SIGNING_SECRET;

    if (!secret || !(await verifySignedRequest(request, secret, MAX_BODY_BYTES))) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
    }

    let json: unknown;

    try {
        json = await request.json();
    } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parsed = vGatewayNotifications.safeParse(json);

    if (!parsed.ok || parsed.value.notifications.length > MAX_NOTIFICATIONS_PER_BATCH) {
        return Response.json({ error: "Invalid notifications payload" }, { status: 400 });
    }

    const { notifications, userId } = parsed.value;
    // Signed, so it passed the replay window above: a number by construction.
    const requestedAt = Number(request.headers.get("X-Timestamp"));
    // A `block`-only rule is enforced, not announced; the gateway does not send it, and a stray one is skipped.
    const alerts = notifications
        .filter((notification) => notification.action !== "block")
        .map((notification) => toUsageAlert(userId, notification, requestedAt));

    try {
        if (alerts.length > 0) {
            // One mutation on the user's shard for the whole batch: it fits the gateway's request deadline however many rules fired.
            await context.forShard(userId).runMutation(internal.notifications.functions.createNotifications, { notifications: alerts });
        }
    } catch (error) {
        console.error("[GatewayNotifications] Failed to write notifications:", error);

        return Response.json({ error: "Failed to write notifications" }, { status: 500 });
    }

    return Response.json({ ok: true }, { status: 200 });
};
