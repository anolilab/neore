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

/** The farthest a snooze may end, from now. Mirrors the server's limit (`backend/lunora/chat/lib/thread-state-logic.ts`). */
const SNOOZE_MAX_MS = 366 * 24 * HOUR_MS;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;

/**
 * When a custom snooze ends, from a `datetime-local` value (local wall-clock time, `YYYY-MM-DDTHH:mm`), or `undefined` when the
 * value is unreadable, not in the future, or more than the server's year away. A time a daylight-saving change skips resolves
 * as the `Date` constructor does, to the hour after.
 */
export const customSnoozeUntil = (localValue: string, now: number): number | undefined => {
    const match = LOCAL_DATE_TIME.exec(localValue);

    if (!match) {
        return undefined;
    }

    const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
    const until = new Date(year, month - 1, day, hour, minute).getTime();

    return until > now && until <= now + SNOOZE_MAX_MS ? until : undefined;
};

/** This tab's last choice stamp. */
const choiceClock = { last: 0 };

/**
 * The ordering stamp of a snooze choice made now: the clock, but always after this tab's previous stamp. Two choices in the same
 * millisecond keep the order they were made in, whatever order their writes reach the server (`setThreadSnooze` drops the older).
 */
export const nextSnoozeChoiceAt = (now: number): number => {
    choiceClock.last = Math.max(now, choiceClock.last + 1);

    return choiceClock.last;
};
