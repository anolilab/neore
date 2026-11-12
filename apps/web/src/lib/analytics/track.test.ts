import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PENDING_EVENTS_KEY } from "./posthog-client";
import { resetAnalyticsIdentity, trackEvent } from "./track";

describe(resetAnalyticsIdentity, () => {
    beforeEach(() => {
        vi.stubEnv("VITE_POSTHOG_API_KEY", "phc_a+b/c=");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        localStorage.clear();
        sessionStorage.clear();
    });

    it("removes the identity PostHog stored when a sign-out comes before its chunk has loaded", () => {
        const name = "ph_phc_aPLbSLcEQ_posthog";

        // eslint-disable-next-line unicorn/no-document-cookie -- seeds the cookie posthog-js would have written
        document.cookie = `${name}=${encodeURIComponent(JSON.stringify({ distinct_id: "user-1" }))}; path=/`;
        localStorage.setItem(name, JSON.stringify({ distinct_id: "user-1" }));
        localStorage.setItem(`${name}__flags`, "{}");
        sessionStorage.setItem("ph_phc_aPLbSLcEQ_window_id", "window");
        localStorage.setItem("ph_other_posthog", "kept");

        resetAnalyticsIdentity();

        expect(document.cookie).not.toContain(name);
        expect(Object.keys(localStorage)).toStrictEqual(["ph_other_posthog"]);
        expect(sessionStorage).toHaveLength(0);
    });
});

describe(trackEvent, () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it("queues an event tracked before PostHog has loaded and answers that it was not sent yet", () => {
        expect(trackEvent("onboarding_started", {})).toBe(false);
        expect(JSON.parse(sessionStorage.getItem(PENDING_EVENTS_KEY) ?? "[]")).toMatchObject([{ event: "onboarding_started", properties: {} }]);
    });
});
