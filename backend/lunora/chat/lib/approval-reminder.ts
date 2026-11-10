/**
 * One reminder push for a pending approval, four hours after it was asked. The owner only sees the push; nothing else
 * about the request changes, and its expiry (`tool-approval-cleanup.ts`) is untouched.
 *
 * A pause asks for one or more requests at the same moment. Its rows share the thread and creation time, so they are looked at
 * together: every request of the pause is classified first, then one push goes out if the pause holds an ordinary approval the
 * latest turn still waits on. A question or secret request is answered in the chat and never pushed, and a request the latest
 * turn no longer holds is superseded and pushed for nothing. Every row is marked `reminderSentAt` once the pause is decided,
 * so a later tick never repeats it, and a push that could not be written leaves its rows unmarked for the next tick to retry.
 *
 * The sweep reads only the rows created in a one-hour window that ends at the reminder point. The owner's shard schedules a
 * sweep for the moment each pause comes due (`chat/approval-reminder-sweep.ts`), so an idle shard is not left to housekeeping.
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

/** When the owner's sweep is scheduled for a pause: a minute after its reminder point, so the pause is inside the window. */
export const APPROVAL_REMINDER_SCHEDULE_DELAY_MS = APPROVAL_REMINDER_AFTER_MS + 60 * 1000;

/**
 * Rows read per sweep. The index cannot skip reminded rows, so they count toward this; it bounds the work of one visit, and a
 * shard with more due rows than this is swept again on the next scheduled visit.
 */
const REMINDER_BATCH = 1000;

/** Whether a request is an ordinary approval the owner can act on on the phone: not a question and not a secret request. */
const isOrdinaryApproval = (toolName: string | null | undefined): boolean =>
    toolName !== undefined && toolName !== ASK_USER_TOOL_NAME && toolName !== REQUEST_SECRET_TOOL_NAME;

/** Reminds each pending request in the window once. Returns how many rows it looked at. */
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

    // One pause: the rows that share a thread and a creation time were asked together.
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
        const live = thread !== null && thread.deleted !== true;

        // Every request of the pause is classified before anything is sent, so a question first in the pause cannot hide an approval
        // after it. The first ordinary approval the latest turn still holds is the one the push names.
        let actionable: (typeof unsent)[number] | undefined;

        if (thread && live) {
            for (const row of rows) {
                const request = await findPendingRequestOnLatestTurn(ctx, thread._id, row.approvalId);

                if (actionable === undefined && request !== undefined && isOrdinaryApproval(request.toolName)) {
                    actionable = row;
                }
            }
        }

        if (thread && live && actionable !== undefined) {
            const notified = await notifyQuietly(ctx, {
                dedupeKey: `tool_approval_reminder:${first.threadId}:${first.createdAt}`,
                link: `/chat/${first.threadId}`,
                title: thread.title ?? "Chat",
                type: "tool_approval",
                userId: first.userId,
            });

            // The write failed (`notifyQuietly` returns null): leave the rows unmarked, so a later tick in the window sends it.
            if (notified === null) {
                continue;
            }
        }

        // Nothing to send (a question, a superseded request, or a gone thread): the pause is decided, so its rows are marked.
        for (const row of rows) {
            await patchRow(ctx.db, "toolApprovalRuns", row, { reminderSentAt: now });
        }
    }

    return unsent.length;
};
