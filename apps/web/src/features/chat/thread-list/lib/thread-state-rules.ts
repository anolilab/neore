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

/** A `datetime-local` value: `YYYY-MM-DDTHH:mm`, local wall-clock time. */
const LOCAL_DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u;

/** The farthest a snooze may end, from now. Mirrors the server's limit (`chat/lib/thread-state-logic.ts`). */
const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * The time a custom snooze ends, from a `datetime-local` value (local wall-clock time, `YYYY-MM-DDTHH:mm`).
 * `undefined` when the value is empty or unreadable, or the time is not in the future or is further than the
 * server accepts. The server checks the same range; this only keeps the picker from sending a time it refuses.
 */
export const customSnoozeUntil = (localValue: string, now: Date): number | undefined => {
    if (!LOCAL_DATE_TIME_RE.test(localValue)) {
        return undefined;
    }

    const parsed = new Date(localValue);
    const until = parsed.getTime();

    // A time inside a daylight-saving gap does not exist, and the clock would move it: refuse the value rather than wake at another time.
    const [datePart = "", timePart = ""] = localValue.split("T", 2);
    const [year, month, day] = datePart.split("-", 3).map(Number);
    const [hour, minute] = timePart.split(":", 2).map(Number);
    const exists =
        parsed.getFullYear() === year &&
        parsed.getMonth() + 1 === month &&
        parsed.getDate() === day &&
        parsed.getHours() === hour &&
        parsed.getMinutes() === minute;

    if (!exists || !Number.isFinite(until) || until <= now.getTime() || until > now.getTime() + SNOOZE_MAX_MS) {
        return undefined;
    }

    return until;
};
