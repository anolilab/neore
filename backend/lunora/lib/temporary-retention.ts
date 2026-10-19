/**
 * The retention a temporary chat gets when the caller names none: the user's
 * stored setting, or a day. The setting is stored as a bare number, so a value
 * outside the 1-168 hour range that the explicit `retentionHours` argument
 * allows (zero, negative, absurd) falls back instead of expiring the chat at once.
 */
const MIN_RETENTION_HOURS = 1;
const MAX_RETENTION_HOURS = 168;
const DEFAULT_RETENTION_HOURS = 24;

export const storedRetentionHours = (stored: number | undefined): number =>
    stored !== undefined && Number.isFinite(stored) && stored >= MIN_RETENTION_HOURS && stored <= MAX_RETENTION_HOURS ? stored : DEFAULT_RETENTION_HOURS;
