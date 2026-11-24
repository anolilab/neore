import { describe, expect, it } from "vitest";

import { DEFAULT_USAGE_LIMIT_PREFERENCES, usageLimitPreferencesOf } from "./usage-limit-settings";

describe("usageLimitPreferencesOf", () => {
    it("is today's behaviour when nothing is stored: resume on, no snooze", () => {
        expect(usageLimitPreferencesOf(undefined)).toStrictEqual({ resumeAfterLimit: true, snoozeUntilReset: false });
        expect(usageLimitPreferencesOf({})).toStrictEqual(DEFAULT_USAGE_LIMIT_PREFERENCES);
    });

    it("reads resuming after a limit off only from a stored false", () => {
        expect(usageLimitPreferencesOf({ resumeAfterUsageLimit: false }).resumeAfterLimit).toBe(false);
        expect(usageLimitPreferencesOf({ resumeAfterUsageLimit: true }).resumeAfterLimit).toBe(true);
    });

    it("reads snoozing until the reset on only from a stored true", () => {
        expect(usageLimitPreferencesOf({ snoozeUntilUsageLimitReset: true }).snoozeUntilReset).toBe(true);
        expect(usageLimitPreferencesOf({ snoozeUntilUsageLimitReset: false }).snoozeUntilReset).toBe(false);
    });
});
