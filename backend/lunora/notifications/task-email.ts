/**
 * OPT-IN email for a task or trigger run that finished with a result.
 *
 * The in-app notification stays the source of truth. `notify()` writes an
 * `outcomeEmails` outbox row in the same transaction as a NEW notification (so a
 * duplicate never mails), and the per-shard housekeeping sweep
 * ({@link dispatchOutcomeEmails}) schedules {@link sendPendingOutcomeEmails}, the
 * action that renders and queues the mail. No query or mutation touches the mailer.
 */
import { v } from "lunorash/server";

import { internal } from "../_generated/internal";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { saveUserSettings } from "../auth/lib/preference-writes";
import { queueEmail } from "../email/mailer";
import { SITE_URL } from "../env";
import { isAccountDeletionUnderway } from "../gdpr/deletion-guard";
import { authMutation, rateLimit } from "../lib/crpc";
import { MAX_LENGTH } from "../lib/validators";
import { patchById } from "../lib/patch";

/** Pending rows one send run takes; the rest wait for the next sweep. */
const SEND_BATCH = 20;

/** A row that failed this many times is given up on. */
export const OUTCOME_EMAIL_MAX_ATTEMPTS = 5;
/** Sent and failed rows are pruned after this long. */
export const OUTCOME_EMAIL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 200;

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
    .input({ userId: v.string().max(MAX_LENGTH.id) })
    .output(v.union(v.string(), v.null()))
    .query(async ({ args: { userId }, ctx }) => {
        // Checked again here: the setting or the account may have changed after the row was written.
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

/** A claim this old belongs to a run that died; its row is sent again by the next run. */
const OUTCOME_CLAIM_RECOVERY_MS = 10 * 60 * 1000;

export const listPendingOutcomeEmails = internalQuery
    .input({})
    .output(v.array(v.object({ id: v.id("outcomeEmails"), link: v.string(), title: v.string(), userId: v.string() })))
    .query(async ({ ctx }) => {
        const cutoff = Date.now() - OUTCOME_CLAIM_RECOVERY_MS;
        const { page: pending } = await ctx.db.outcomeEmails.findMany({ limit: SEND_BATCH, orderBy: [{ createdAt: "asc" }], where: { status: "pending" } });
        const { page: abandoned } = await ctx.db.outcomeEmails.findMany({
            limit: SEND_BATCH,
            orderBy: [{ createdAt: "asc" }],
            where: { claimedAt: { lt: cutoff }, status: "sending" },
        });

        return [...pending, ...abandoned].slice(0, SEND_BATCH).map(({ _id, link, title, userId }) => {
            return { id: _id, link, title, userId };
        });
    });

/**
 * Takes a row for one send run. Two runs that list the same row cannot both send it: the second
 * finds it already `sending` and skips. Returns false when the row is not available.
 */
export const claimOutcomeEmail = internalMutation
    .input({ id: v.id("outcomeEmails") })
    .output(v.boolean())
    .mutation(async ({ args: { id }, ctx }) => {
        const row = await ctx.db.get(id);
        const abandoned = row?.status === "sending" && (row.claimedAt ?? 0) < Date.now() - OUTCOME_CLAIM_RECOVERY_MS;

        if (!row || (row.status !== "pending" && !abandoned)) {
            return false;
        }

        await ctx.db.patch(id, { claimedAt: Date.now(), status: "sending" });

        return true;
    });

/**
 * Records one send. `skipped` (setting off, account being deleted, no verified address)
 * deletes the row: nothing is owed. A failure counts an attempt and keeps the row
 * pending until the cap, then marks it `failed`.
 */
export const settleOutcomeEmail = internalMutation
    .input({ id: v.id("outcomeEmails"), result: v.union(v.literal("sent"), v.literal("skipped"), v.literal("failed")) })
    .output(v.null())
    .mutation(async ({ args: { id, result }, ctx }) => {
        const row = await ctx.db.get(id);

        if (!row || (row.status !== "sending" && row.status !== "pending")) {
            return null;
        }

        if (result === "skipped") {
            await ctx.db.delete(id);
        } else if (result === "sent") {
            await patchById(ctx.db, id, { claimedAt: undefined, sentAt: Date.now(), status: "sent" });
        } else {
            const attempts = row.attempts + 1;
            const gaveUp = attempts >= OUTCOME_EMAIL_MAX_ATTEMPTS;

            if (gaveUp) {
                console.warn(`[notifications] Giving up on the outcome email for ${row.notificationId as string} after ${attempts} attempts`);
            }

            await patchById(ctx.db, id, { attempts, claimedAt: undefined, status: gaveUp ? "failed" : "pending" });
        }

        return null;
    });

/**
 * The housekeeping sweep (`lib/shard-housekeeping.ts`): prunes old sent and failed rows,
 * and hands any pending ones to the sending action. A failed schedule costs nothing: the
 * rows stay pending for the next sweep.
 */
export const dispatchOutcomeEmails = internalMutation
    .input({})
    .output(v.null())
    .mutation(async ({ ctx }) => {
        const cutoff = ctx.now - OUTCOME_EMAIL_RETENTION_MS;

        for (const status of ["sent", "failed"] as const) {
            const { page } = await ctx.db.outcomeEmails.findMany({ limit: PRUNE_BATCH, where: { createdAt: { lt: cutoff }, status } });

            for (const row of page) {
                await ctx.db.delete(row._id);
            }
        }

        // A pending row, or a claim abandoned by a run that died: either needs a send run.
        const { page: pending } = await ctx.db.outcomeEmails.findMany({ limit: 1, where: { status: "pending" } });
        const { page: abandoned } = await ctx.db.outcomeEmails.findMany({
            limit: 1,
            where: { claimedAt: { lt: ctx.now - OUTCOME_CLAIM_RECOVERY_MS }, status: "sending" },
        });

        if (pending.length > 0 || abandoned.length > 0) {
            await ctx.scheduler.runAfter(0, internal.notifications.task_email.sendPendingOutcomeEmails, {});
        }

        return null;
    });

/** Sends the shard's pending outbox rows. The mailer is only ever reached from here. */
export const sendPendingOutcomeEmails = internalAction
    .input({})
    .output(v.null())
    .action(async ({ ctx }) => {
        const pending = await ctx.runQuery(internal.notifications.task_email.listPendingOutcomeEmails, {});

        for (const { id, link, title, userId } of pending) {
            // Another run may have taken this row since it was listed.
            if (!(await ctx.runMutation(internal.notifications.task_email.claimOutcomeEmail, { id }))) {
                continue;
            }

            let result: "failed" | "sent" | "skipped" = "skipped";

            try {
                const to = await ctx.runQuery(internal.notifications.task_email.loadRecipientEmail, { userId });

                if (to && SITE_URL) {
                    const { default: TaskOutcomeEmail } = await import("../email/templates/task-outcome");
                    const subject = `${title.replaceAll(/\s+/g, " ")} has finished`;

                    await queueEmail({ react: TaskOutcomeEmail({ title, url: new URL(link, SITE_URL).href }), subject, to });
                    result = "sent";
                }
            } catch (error) {
                console.warn("[notifications] Failed to queue the outcome email:", error);
                result = "failed";
            }

            await ctx.runMutation(internal.notifications.task_email.settleOutcomeEmail, { id, result });
        }

        return null;
    });
