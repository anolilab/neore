/**
 * One reminder push for a request left pending, four hours after it was asked. The owner only sees the push; nothing else
 * about the request changes, and its expiry (`tool-approval-cleanup.ts`) is untouched.
 *
 * A pause asks for one or more requests at the same moment, and its rows share a pause id (the first request's id). They are
 * looked at together: every request of the pause is classified first, then one push goes out for the pause. The push names an
 * ordinary approval when the latest turn still waits on one; a pause that waits only on a question or a secret request gets the
 * generic push of that kind, which names nothing. A request the latest turn no longer holds is superseded and pushed for nothing.
 * Every row is marked `reminderSentAt` once the pause is decided, so a later tick never repeats it, and a push that could not be
 * written leaves its rows unmarked for the next tick to retry.
 *
 * The sweep reads the rows created in a one-hour window that ends at the reminder point, and walks past a full page of them so
 * rows already reminded cannot hide the ones behind them. The owner's shard schedules a sweep for the moment each pause comes due
 * (`chat/approval-reminder-sweep.ts`), so an idle shard is not left to housekeeping.
 */
import type { Doc, Id } from "../../_generated/dataModel";
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

/** Rows read per page of a sweep. */
const REMINDER_BATCH = 1000;

/** Pages read per sweep: bounds the work of one visit. A shard with more due rows is swept again on the next scheduled visit. */
const REMINDER_MAX_PAGES = 10;

type DueRow = Doc<"toolApprovalRuns">;

/** Whether a request is an ordinary approval the owner can act on on the phone: not a question and not a secret request. */
const isOrdinaryApproval = (toolName: string | null | undefined): boolean =>
    toolName !== undefined && toolName !== ASK_USER_TOOL_NAME && toolName !== REQUEST_SECRET_TOOL_NAME;

/** The push a pause gets, by what its pending requests are: an ordinary approval names the tool, the others stay generic. */
const pushType = (kinds: ReadonlySet<"approval" | "question" | "secret">): "ask_user" | "secret_request" | "tool_approval" | undefined => {
    if (kinds.has("approval")) {
        return "tool_approval";
    }

    if (kinds.has("secret")) {
        return "secret_request";
    }

    if (kinds.has("question")) {
        return "ask_user";
    }

    return undefined;
};

/** The rows of one pause, keyed by its thread and pause id. Rows written before pause ids share a creation time instead. */
const pauseKey = (row: DueRow): string => `${row.threadId}\u{0}${row.pauseId ?? `at:${row.createdAt}`}`;

/** Reminds each pending pause in the window once. Returns how many rows it looked at. */
export const remindPendingApprovals = async (ctx: MutationCtx, now: number): Promise<number> => {
    const reminderPoint = now - APPROVAL_REMINDER_AFTER_MS;
    let lower = reminderPoint - APPROVAL_REMINDER_WINDOW_MS;
    let looked = 0;

    for (let page = 0; page < REMINDER_MAX_PAGES; page += 1) {
        // Both ends are inclusive: a request asked exactly four hours ago is due now.
        const due = await ctx.db
            .query("toolApprovalRuns")
            .withIndex("by_status_createdAt", (q) => q.eq("status", "pending").gte("createdAt", lower).lte("createdAt", reminderPoint))
            .take(REMINDER_BATCH);

        const unsent = due.filter((row) => row.reminderSentAt === undefined);

        looked += unsent.length;
        await remindPauses(ctx, unsent, now);

        const last = due.at(-1)?.createdAt;

        // A short page is the end of the window; a page that did not move past its start cannot be walked further.
        if (due.length < REMINDER_BATCH || last === undefined || last <= lower) {
            break;
        }

        lower = last;
    }

    return looked;
};

const remindPauses = async (ctx: MutationCtx, unsent: DueRow[], now: number): Promise<void> => {
    const pauses = new Map<string, DueRow[]>();

    for (const row of unsent) {
        const key = pauseKey(row);

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
        // after it. The latest turn decides which of them are still waiting.
        const kinds = new Set<"approval" | "question" | "secret">();
        // The first ordinary approval the latest turn still holds: the one the push's Approve and Deny act on, and none otherwise.
        let actionableId: string | undefined;

        if (thread && live) {
            for (const row of rows) {
                const request = await findPendingRequestOnLatestTurn(ctx, thread._id, row.approvalId);

                if (request === undefined) {
                    continue;
                }

                if (isOrdinaryApproval(request.toolName)) {
                    kinds.add("approval");
                    actionableId ??= row.approvalId;
                } else if (request.toolName === REQUEST_SECRET_TOOL_NAME) {
                    kinds.add("secret");
                } else {
                    kinds.add("question");
                }
            }
        }

        const type = pushType(kinds);

        if (thread && live && type !== undefined) {
            const notified = await notifyQuietly(ctx, {
                dedupeKey: `tool_approval_reminder:${first.threadId}:${first.pauseId ?? first.createdAt}`,
                link: `/chat/${first.threadId}`,
                // The phone's approve and deny act on this approval, as on the first push (`notifications/phone-delivery.ts`).
                ...(actionableId !== undefined && { approvalId: actionableId }),
                title: thread.title ?? "Chat",
                type,
                userId: first.userId,
            });

            // The write failed (`notifyQuietly` returns null): leave the rows unmarked, so a later tick in the window sends it.
            if (notified === null) {
                continue;
            }
        }

        // Nothing to send (a superseded pause, or a gone thread): the pause is decided, so its rows are marked.
        for (const row of rows) {
            await patchRow(ctx.db, "toolApprovalRuns", row, { reminderSentAt: now });
        }
    }
};
