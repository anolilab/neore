/** How far ahead a thread may be snoozed. */
export const SNOOZE_MAX_MS = 366 * 24 * 60 * 60 * 1000;

/** A snooze ends in the future, and not more than {@link SNOOZE_MAX_MS} from now. */
export const isSnoozeInRange = (until: number, now: number): boolean => Number.isFinite(until) && until > now && until <= now + SNOOZE_MAX_MS;

/** How far ahead of the server's clock a client's choice stamp is trusted as it is. */
export const CHOICE_AHEAD_ALLOWANCE_MS = 60 * 1000;

/**
 * The ordering stamp of an owner's snooze choice (`threads.snoozeChosenAt`). The client stamps a choice when it is made, strictly
 * increasing per tab, and a write queued offline keeps that stamp. The server trusts it up to {@link CHOICE_AHEAD_ALLOWANCE_MS} ahead
 * of its own clock, so a device a little ahead keeps its own choices in order whatever order they arrive in, and caps it there, so a
 * device far ahead shuts other choices out for at most that long. A request without a stamp (an older client) is stamped now.
 *
 * Limits, by design: a device more than the allowance ahead caps every choice to the same bound, so its choices then apply in the
 * order they arrive. A device ahead by up to the allowance can have a choice made just before a wake that it had not yet delivered
 * still apply after it; one behind can have a choice made just after a wake dropped. Either way the client learns `applied`.
 */
export const snoozeChoiceStamp = (chosenAt: number | undefined, now: number): number => Math.min(chosenAt ?? now, now + CHOICE_AHEAD_ALLOWANCE_MS);
