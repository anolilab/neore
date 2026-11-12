import { useEffectivePermissions } from "@c15t/react";
import type { PostHogConfig, PostHogInterface } from "posthog-js";
import { posthog } from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FC, PropsWithChildren } from "react";
import { useEffect } from "react";

import { reportFirstNativeLaunch } from "@/lib/analytics/first-native-launch";
import { redactPromptFromEvent } from "@/lib/analytics/redact-prompt";

// The consent state PostHog should follow. `PostHogConsentSync` is a child of `AnalyticsProvider`, so its first
// effect runs before `posthog.init`; the `loaded` callback applies whatever arrived before then.
const consentState: { measurement?: boolean } = {};

const applyMeasurementConsent = (granted: boolean): void => {
    if (granted) {
        posthog.opt_in_capturing();
        // A launch that happened before consent is reported now; its stored flag keeps it from repeating.
        reportFirstNativeLaunch();
    } else {
        posthog.opt_out_capturing();
    }
};

/**
 * Apply the effective consent permissions to PostHog.
 *
 * Mounted inside the live `<ConsentProvider>` in `routes/__root.tsx`. c15t 3's callbacks no longer fire at
 * startup, so this follows the permissions hook instead: it runs once with the stored (or default) state and
 * again on every change, as v2's `onConsentSet` did.
 */
export const PostHogConsentSync: FC = () => {
    const { measurement } = useEffectivePermissions();

    useEffect(() => {
        consentState.measurement = measurement;

        if (posthog.__loaded) {
            applyMeasurementConsent(measurement);
        }
    }, [measurement]);

    return null;
};

/** PostHog's options that do not depend on the session. */
export const POSTHOG_OPTIONS = {
    // A prompt link's text, and every address's fragment, never leave the browser in an event (`lib/analytics/redact-prompt.ts`).
    before_send: redactPromptFromEvent,
    capture_pageview: true,
    // PostHog will not set any cookies until the user has given consent
    cookieless_mode: "on_reject",
    // A guest link carries its bearer token in the fragment (`/guest#<token>`): PostHog keeps no address's fragment, not in
    // the cookie or storage it writes (`$initial_person_info`, session properties) nor in an event. `before_send` stays the backstop.
    disable_capture_url_hashes: true,
    person_profiles: "always",
} as const satisfies Partial<PostHogConfig>;

/**
 * Real-user load timing (`lib/analytics/load-timing/report-load-timing.ts`). Its code and `web-vitals` load once the
 * browser is idle, so they stay out of the first-load bundle; the browser buffers the entries it reads.
 */
const startLoadTiming = (): void => {
    void import("@/lib/analytics/load-timing/report-load-timing")
        .then(({ reportLoadTiming }) => reportLoadTiming())
        // A chunk that fails to load (offline, a deploy in between) only costs this page's timings.
        .catch(() => undefined);
};

/** PostHog's `loaded` callback: applies the consent state that arrived before `posthog.init` finished. */
export const onPostHogLoaded = (ph: PostHogInterface): void => {
    if (import.meta.env.DEV) {
        // In development, opt in for debugging
        ph.opt_in_capturing();
        ph.debug();
    }

    if (consentState.measurement !== undefined) {
        applyMeasurementConsent(consentState.measurement);
    }

    // Here, not in an effect: AnalyticsProvider wraps the app, so child effects run before PostHog loads.
    reportFirstNativeLaunch();

    if (typeof globalThis.requestIdleCallback === "function") {
        globalThis.requestIdleCallback(startLoadTiming, { timeout: 5000 });
    } else {
        setTimeout(startLoadTiming, 3000);
    }
};

const AnalyticsProvider: FC<PropsWithChildren> = ({ children }) => {
    useEffect(() => {
        if (import.meta.env.DEV || !globalThis || !import.meta.env.VITE_POSTHOG_API_KEY || !import.meta.env.VITE_POSTHOG_HOST) {
            return;
        }

        // Get bootstrapped data from meta tag (injected by server)
        let flagData: Record<string, boolean | string> | undefined;
        let distinctId: string | undefined;

        if (globalThis.document) {
            const metaTag = document.querySelector('meta[name="posthog-data"]');

            if (metaTag) {
                try {
                    const data = JSON.parse(metaTag.getAttribute("content") ?? "{}") as {
                        distinctId?: string;
                        flags?: Record<string, boolean | string>;
                    };

                    distinctId = data.distinctId;
                    flagData = data.flags;
                } catch {
                    // Silently fail if parsing fails
                }
            }
        }

        // Initialize PostHog with cookieless mode for GDPR compliance
        // PostHog will operate in cookieless mode until consent is granted
        posthog.init(import.meta.env.VITE_POSTHOG_API_KEY, {
            api_host: import.meta.env.VITE_POSTHOG_HOST,
            // Bootstrap feature flags from server-side rendering
            bootstrap:
                distinctId && flagData
                    ? {
                          distinctID: distinctId,
                          featureFlags: flagData,
                          isIdentifiedID: false,
                      }
                    : undefined,
            ...POSTHOG_OPTIONS,
            loaded: onPostHogLoaded,
        });
    }, []);

    return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};

export default AnalyticsProvider;
