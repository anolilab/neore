/**
 * One reminder push for a pending approval, four hours after it was asked. The owner only sees the push; nothing else
 * about the request changes, and its expiry (`tool-approval-cleanup.ts`) is untouched.
 *
 * A pause asks for one or more approvals at the same moment. Its rows share the thread and creation time, so they get one
 * push between them, and every row is marked `reminderSentAt` so a later tick never repeats it.
 *
 * The sweep reads only the rows created in a one-hour window that ends at the reminder point. A row that falls in the
 * window is reminded by the first tick that sees it, so one missed minute does not lose it, and the window stays small
 * however many approvals are pending. A row older than the window (the sweep was down for an hour) gets no reminder.
 */
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import { patchRow } from "../../lib/patch";
import { notifyQuietly } from "../../notifications/notify";
import { ASK_USER_TOOL_NAME } from "../tools/ask-user-constants";
import { REQUEST_SECRET_TOOL_NAME } from "../tools/request-secret-constants";
import { findPendingRequestOnLatestTurn } from "./tool-approval-claim";

/** A pending request is reminded this long after it was created. */
export const APPROVAL_REMINDER_AFTER_MS = 4 * 60 * 60 * 1000;

/** How far before the reminder point the sweep still looks: the tick cadence with room to spare. */
export const APPROVAL_REMINDER_WINDOW_MS = 60 * 60 * 1000;

const REMINDER_BATCH = 100;

/** Reminds each pending request in the window once. Returns how many rows it marked. */
export const remindPendingApprovals = async (ctx: MutationCtx, now: number): Promise<number> => {
    const reminderPoint = now - APPROVAL_REMINDER_AFTER_MS;
    const due = await ctx.db
        .query("toolApprovalRuns")
        .withIndex("by_status_createdAt", (q) =>
            q
                .eq("status", "pending")
                .gte("createdAt", reminderPoint - APPROVAL_REMINDER_WINDOW_MS)
                .lt("createdAt", reminderPoint),
        )
        .take(REMINDER_BATCH);
    const unsent = due.filter((row) => row.reminderSentAt === undefined);

    // One push per pause: the rows that share a thread and a creation time were asked together.
    const pauses = new Map<string, typeof unsent>();

    for (const row of unsent) {
        const key = `${row.threadId}\u{0}${row.createdAt}`;

        pauses.set(key, [...(pauses.get(key) ?? []), row]);
    }

    for (const rows of pauses.values()) {
        const [first] = rows;

        if (first === undefined) {
            continue;
        }

        const thread = await ctx.db.get("threads", first.threadId as Id<"threads">);
        const request = thread && thread.deleted !== true ? await findPendingRequestOnLatestTurn(ctx, thread._id, first.approvalId) : undefined;

        // A question or a secret request is answered in the chat, not approved: a push that says "approval" would be wrong, and the
        // phone cannot act on it. A request the lookup cannot find keeps the plain reminder.
        const answeredInChat = request?.toolName === ASK_USER_TOOL_NAME || request?.toolName === REQUEST_SECRET_TOOL_NAME;

        // A thread that is gone or deleted, or a question, gets no push, but its rows are still marked so the sweep moves on.
        if (!answeredInChat && thread && thread.deleted !== true) {
            await notifyQuietly(ctx, {
                // The phone's approve and deny act on this approval, as on the first push (`notifications/phone-delivery.ts`).
                approvalId: first.approvalId,
                dedupeKey: `tool_approval_reminder:${first.threadId}:${first.createdAt}`,
                link: `/chat/${first.threadId}`,
                title: thread.title ?? "Chat",
                type: "tool_approval",
                userId: first.userId,
            });
        }

        for (const row of rows) {
            await patchRow(ctx.db, "toolApprovalRuns", row, { reminderSentAt: now });
        }
    }

    return unsent.length;
};
