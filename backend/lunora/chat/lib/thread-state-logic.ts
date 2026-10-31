/** How far ahead a thread may be snoozed. */
export const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** A snooze ends in the future, and not more than {@link SNOOZE_MAX_MS} from now. */
export const isSnoozeInRange = (until: number, now: number): boolean => Number.isFinite(until) && until > now && until <= now + SNOOZE_MAX_MS;
