/**
 * OPT-IN email for a task or trigger run that finished with a result.
 *
 * The in-app notification stays the source of truth. `notify()` schedules
 * {@link sendTaskOutcomeEmail} on the shard that writes a NEW notification, so a
 * redelivery or a duplicate never mails, and neither does a write handed to
 * another shard without being mailed there. The action renders and queues the
 * mail, so no mutation touches the mailer.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { saveUserSettings } from "../auth/lib/preference-writes";
import { queueEmail } from "../email/mailer";
import { SITE_URL } from "../env";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, rateLimit } from "../lib/crpc";

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

export const loadRecipientEmail = internalQuery
    .input({ userId: v.string() })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { userId }, ctx }) => {
        // Checked again here: the setting or the account may have changed after the mail was scheduled.
        if (await isAccountDeletionUnderway(ctx, userId)) {
            return null;
        }

        const settings = await ctx.db.userSettings.findFirst({ where: { userId } });

        if (settings?.taskEmailEnabled !== true) {
            return null;
        }

        const user = await ctx.db.user.findFirst({ where: { _id: userId as Id<"user"> } });

        // Only a verified address: sign-up does not verify it, so an unverified one may belong to someone else.
        if (!user?.emailVerified) {
            return null;
        }

        return user.email || null;
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
