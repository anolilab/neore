import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPostHog, loadPostHog, PENDING_EVENTS_KEY, setAnalyticsIdentity, setMeasurementConsent, startPostHog } from "./posthog-client";
import { reportCaughtError, resetAnalyticsIdentity, trackEvent } from "./track";

const posthog = vi.hoisted(() => {
    return {
        __loaded: true,
        capture: vi.fn(),
        captureException: vi.fn(),
        get_distinct_id: vi.fn(() => "anonymous-1"),
        get_property: vi.fn((_key: string): unknown => undefined),
        opt_in_capturing: vi.fn(),
        opt_out_capturing: vi.fn(),
        has_opted_out_capturing: vi.fn(() => false),
        register: vi.fn(),
        reset: vi.fn(),
    };
});

vi.mock("./posthog-js", () => {
    return { posthog };
});

describe(resetAnalyticsIdentity, () => {
    beforeEach(() => {
        vi.stubEnv("VITE_POSTHOG_API_KEY", "phc_a+b/c=");
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        localStorage.clear();
        sessionStorage.clear();
    });

    it("clears the session's PostHog keys even when localStorage is blocked", () => {
        sessionStorage.setItem("ph_phc_aPLbSLcEQ_window_id", "window");

        const blocked = vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
            throw new DOMException("blocked", "SecurityError");
        });

        try {
            resetAnalyticsIdentity();
        } finally {
            blocked.mockRestore();
        }

        expect(sessionStorage.getItem("ph_phc_aPLbSLcEQ_window_id")).toBeNull();
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
        setMeasurementConsent(true);
        expect(trackEvent("onboarding_started", {})).toBe(false);
        expect(JSON.parse(sessionStorage.getItem(PENDING_EVENTS_KEY) ?? "[]")).toMatchObject([{ event: "onboarding_started", properties: {} }]);
    });
});

describe(reportCaughtError, () => {
    it("queues an error caught before PostHog has started and sends it once it has", async () => {
        const error = new Error("paste failed");

        expect(getPostHog()).toBeUndefined();
        expect(reportCaughtError(error, { feature: "composer-paste" })).toBe(false);

        setAnalyticsIdentity({});
        startPostHog(await loadPostHog(), () => {});

        expect(posthog.captureException).toHaveBeenCalledExactlyOnceWith(error, { feature: "composer-paste" });
    });
});

describe("resetAnalyticsIdentity on a client initialised but not started", () => {
    beforeEach(() => {
        vi.stubEnv("VITE_POSTHOG_API_KEY", "phc_a+b/c=");
        posthog.reset.mockClear();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it("resets the live client, so its next write cannot put the departed identity back", async () => {
        // Fresh modules: an earlier test in this file started PostHog, which would take the started-client path.
        vi.resetModules();

        const client = await import("./posthog-client");
        const track = await import("./track");

        // The chunk loaded and `init` ran; startup still waits for the session.
        await client.loadPostHog();

        expect(client.getStartedPostHog()).toBeUndefined();

        track.resetAnalyticsIdentity();

        expect(posthog.reset).toHaveBeenCalledOnce();
    });
});
