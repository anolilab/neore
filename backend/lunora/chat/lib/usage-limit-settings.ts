/**
 * The two settings a person has for a reply paused by a provider's usage limit (`pause-run.ts`): whether it resumes by
 * itself when the limit resets, and whether its chat is snoozed until then. Absent means today's behaviour: resume on,
 * no snooze. Only the stored `false` / `true` values change anything.
 */
export interface UsageLimitPreferences {
    /** `false`: the person resumes the run themselves; no resume is queued for it. */
    resumeAfterLimit: boolean;
    /** `true`: the chat is snoozed until the reset time, when the provider reported one. */
    snoozeUntilReset: boolean;
}

export const DEFAULT_USAGE_LIMIT_PREFERENCES: UsageLimitPreferences = { resumeAfterLimit: true, snoozeUntilReset: false };

/**
 * What a run uses when the person's settings cannot be read. The saved choice might be "off", so the run waits for the person
 * rather than resuming against it; nothing is snoozed. A failed read is not an absent setting (absent is the default above).
 */
export const UNREADABLE_USAGE_LIMIT_PREFERENCES: UsageLimitPreferences = { resumeAfterLimit: false, snoozeUntilReset: false };

/** The two stored settings (`userSettings`) as the flags a pause reads. */
export const usageLimitPreferencesOf = (
    settings: { resumeAfterUsageLimit?: boolean; snoozeUntilUsageLimitReset?: boolean } | undefined,
): UsageLimitPreferences => {
    return {
        resumeAfterLimit: settings?.resumeAfterUsageLimit !== false,
        snoozeUntilReset: settings?.snoozeUntilUsageLimitReset === true,
    };
};
