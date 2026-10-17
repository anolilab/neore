/**
 * OPT-IN email for a task or trigger run that finished with a result.
 *
 * The in-app notification stays the source of truth: {@link notifyOutcome}
 * writes it through `notify()`, and only a NEW notification (not a redelivery,
 * not handed to another shard) can schedule the mail. The mutation only
 * schedules; {@link sendTaskOutcomeEmail} renders and queues it, so no mutation
 * touches the mailer.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { internalAction, internalQuery } from "../_generated/server";
import { saveUserSettings } from "../auth/lib/preference-writes";
import { queueEmail } from "../email/mailer";
import { SITE_URL } from "../env";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, rateLimit } from "../lib/crpc";
import type { NotificationInput } from "./notify";
import { notify } from "./notify";

/** The settings toggle. */
export const setTaskEmailEnabled = authMutation
    .use(rateLimit("notifications/update"))
    .input({ enabled: v.boolean() })
    .output(v.null())
    .mutation(async ({ args: { enabled }, ctx }) => {
        const { userId } = ctx.user;

        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });

        await saveUserSettings(ctx.db, settings, userId, { taskEmailEnabled: enabled });

        ctx.log.event("notifications.set_task_email_enabled", { enabled });

        return null;
    });

/**
 * Writes the inbox entry (never failing the caller) and, for a successful run
 * that `hasResult`, queues the opted-in email.
 */
export const notifyOutcome = async (ctx: MutationCtx, input: NotificationInput, hasResult: boolean): Promise<void> => {
    try {
        const notificationId = await notify(ctx, input);

        if (!notificationId || !hasResult || input.outcome !== "success" || !input.link) {
            return;
        }

        const settings = await ctx.db.userSettings.findFirst({ where: { userId: input.userId } });

        if (settings?.taskEmailEnabled === true) {
            await ctx.scheduler.runAfter(0, internal.notifications.task_email.sendTaskOutcomeEmail, {
                link: input.link,
                title: input.title,
                userId: input.userId,
            });
        }
    } catch (error) {
        console.warn(`[notifications] Failed to write a ${input.type} notification:`, error);
    }
};

export const loadRecipientEmail = internalQuery
    .input({ userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { userId }, ctx }) => {
        const user = await ctx.db.user.findFirst({ where: { _id: userId as Id<"user"> } });

        return user?.email || null;
    });

export const sendTaskOutcomeEmail = internalAction
    .input({ link: v.string().max(500), title: v.string().max(200), userId: v.string().max(200) })
    .output(v.null())
    .action(async ({ args: { link, title, userId }, ctx }) => {
        const to = await ctx.runQuery(internal.notifications.task_email.loadRecipientEmail, { userId });

        if (!to || !SITE_URL) {
            return null;
        }

        const { default: TaskOutcomeEmail } = await import("../email/templates/task-outcome");
        const subject = `${title.replaceAll(/\s+/g, " ")} has finished`;

        await queueEmail({ react: TaskOutcomeEmail({ title, url: new URL(link, SITE_URL).href }), subject, to });

        return null;
    });
