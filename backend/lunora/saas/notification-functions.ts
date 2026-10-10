import type { Infer } from "lunorash/server";

/**
 * Mutation for persisting gateway notifications.
 */
import { v } from "lunorash/server";

import { internalMutation } from "../_generated/server";
import { authMutation, authQuery, rateLimit } from "../lib/crpc";

const notificationValidator = v.object({
    action: v.union(v.literal("notify"), v.literal("block"), v.literal("notify_and_block")),
    currentValue: v.number(),
    metric: v.string(),
    ruleId: v.string(),
    ruleName: v.string(),
    threshold: v.number(),
});

export const saveNotifications = internalMutation
    .input({
        notifications: v.array(notificationValidator),
        userId: v.string(),
    })
    .mutation(async ({ args: { notifications, userId }, ctx }) => {
        const now = ctx.now;

        await Promise.all(
            notifications.map((n) =>
                ctx.db.insert("gatewayNotifications", {
                    action: n.action,
                    currentValue: n.currentValue,
                    isRead: false,
                    metric: n.metric,
                    ruleId: n.ruleId,
                    ruleName: n.ruleName,
                    threshold: n.threshold,
                    triggeredAt: now,
                    userId,
                }),
            ),
        );
    });

/**
 * List unread gateway notifications for the authenticated user.
 */
const vListNotificationsOutput = v.array(
    v.object({
        action: v.string(),
        currentValue: v.number(),
        id: v.string(),
        isRead: v.boolean(),
        metric: v.string(),
        ruleId: v.string(),
        ruleName: v.string(),
        threshold: v.number(),
        triggeredAt: v.number(),
    }),
);

export const listNotifications = authQuery.output(v.from(vListNotificationsOutput)).query(async ({ ctx }): Promise<Infer<typeof vListNotificationsOutput>> => {
    const { userId } = ctx.user;

    const notifications = await ctx.db
        .query("gatewayNotifications")
        .withIndex("by_userId_isRead", (q) => q.eq("userId", userId))
        .order("desc")
        .take(50);

    return notifications.map((n: any) => {
        return {
            action: n.action,
            currentValue: n.currentValue,
            id: n._id,
            isRead: n.isRead,
            metric: n.metric,
            ruleId: n.ruleId,
            ruleName: n.ruleName,
            threshold: n.threshold,
            triggeredAt: n.triggeredAt,
        };
    });
});

/**
 * Mark notifications as read.
 */
export const markNotificationsRead = authMutation.use(rateLimit("notifications/update")).mutation(async ({ ctx }) => {
    const { userId } = ctx.user;

    const unread = await ctx.db
        .query("gatewayNotifications")
        .withIndex("by_userId_isRead", (q) => q.eq("userId", userId).eq("isRead", false))
        .collect();

    await Promise.all(unread.map((n: any) => ctx.db.patch(n._id, { isRead: true })));

    ctx.log.event("saas.mark_notifications_read", { count: unread.length });
});
