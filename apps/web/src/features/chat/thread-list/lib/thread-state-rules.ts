/** Owner-only thread state as the list rows carry it: absent for threads the caller does not own. */
export interface ThreadOwnerState {
    awaitingInput?: "approval" | "question";
    lastReplyAt?: number;
    lastViewedAt?: number;
    snoozedUntil?: number;
}

/** Whether the thread holds a reply newer than the last view. */
export const hasUnseenReply = (state: ThreadOwnerState): boolean => state.lastReplyAt !== undefined && state.lastReplyAt > (state.lastViewedAt ?? 0);

export type SnoozeChoice = "hour" | "nextWeek" | "tomorrow";

const HOUR_MS = 60 * 60 * 1000;
const MORNING_HOUR = 9;
const MONDAY = 1;

/** A reply the owner has not seen, in a thread that is neither open nor mid-stream. */
export const hasUnreadReply = (state: ThreadOwnerState, context: { isOpen: boolean; isStreaming: boolean }): boolean =>
    !context.isOpen && !context.isStreaming && hasUnseenReply(state);

export const isSnoozed = (snoozedUntil: number | undefined, now: number): boolean => snoozedUntil !== undefined && snoozedUntil > now;

const morningAfter = (now: Date, daysAhead: number): number => {
    const target = new Date(now);

    target.setDate(target.getDate() + daysAhead);
    target.setHours(MORNING_HOUR, 0, 0, 0);

    return target.getTime();
};

/** When a snooze choice ends, in the caller's local time: an hour on, tomorrow 09:00, or the next Monday 09:00. */
export const snoozeUntil = (choice: SnoozeChoice, now: Date): number => {
    if (choice === "hour") {
        return now.getTime() + HOUR_MS;
    }

    if (choice === "tomorrow") {
        return morningAfter(now, 1);
    }

    return morningAfter(now, (MONDAY + 7 - now.getDay()) % 7 || 7);
};
