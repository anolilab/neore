import { describe, expect, it } from "vitest";

import { shouldShowOnboarding } from "./should-show-onboarding";

describe("shouldShowOnboarding", () => {
    it("shows the tour to a signed-in, non-guest user who has not finished it", () => {
        expect(shouldShowOnboarding({ onboardingCompleted: false, user: { isAnonymous: false } })).toBe(true);
    });

    it("skips it for guests", () => {
        expect(shouldShowOnboarding({ onboardingCompleted: false, user: { isAnonymous: true } })).toBe(false);
    });

    it("waits while the session is still loading instead of assuming a registered user", () => {
        expect(shouldShowOnboarding({ onboardingCompleted: false, user: undefined })).toBe(false);
        expect(shouldShowOnboarding({ onboardingCompleted: false, user: null })).toBe(false);
    });

    it("never reopens a finished tour", () => {
        expect(shouldShowOnboarding({ onboardingCompleted: true, user: { isAnonymous: false } })).toBe(false);
    });
});
