import { v } from "lunorash/server";

/**
 * What a notification is about. The UI words each one in the viewer's language
 * (`features/notifications/lib/notification-labels.ts`); the stored `title` is
 * the SUBJECT (a task's title, a trigger's name), not a sentence.
 */
export const vNotificationType = v.union(
    v.literal("task"),
    v.literal("tool_approval"),
    v.literal("ask_user"),
    v.literal("trigger"),
    v.literal("coding_agent"),
    v.literal("eval"),
    v.literal("sub_agent"),
    v.literal("chat_import"),
    v.literal("data_export"),
    v.literal("daily_brief"),
);

export const vNotificationOutcome = v.union(v.literal("success"), v.literal("failure"));

/** The fields a writer supplies, spread into the table's doc fields (see `schema.ts`). */
export const notificationInputFields = {
    body: v.optional(v.string()),
    dedupeKey: v.optional(v.string()),
    link: v.optional(v.string()),
    outcome: v.optional(vNotificationOutcome),
    title: v.string(),
    type: vNotificationType,
    userId: v.string(),
};

/** The same fields as one validator, for the writer's argument type (`notify.ts`). */
export const vNotificationInput = v.object({ ...notificationInputFields });

export const vNotificationView = v.object({
    _id: v.string(),
    body: v.optional(v.string()),
    createdAt: v.number(),
    link: v.optional(v.string()),
    outcome: v.optional(vNotificationOutcome),
    read: v.boolean(),
    title: v.string(),
    type: vNotificationType,
});
