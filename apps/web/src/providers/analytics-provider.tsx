import { posthog } from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import type { FC, PropsWithChildren } from "react";
import { useEffect } from "react";

/**
 * Apply a consent decision to PostHog.
 *
 * This has to be handed to the live `<ConsentManagerProvider>` in
 * `routes/__root.tsx`. It used to be registered here via
 * `configureConsentManager(...)`, whose return value was discarded — the
 * provider builds its own manager from its own options, so these callbacks
 * never ran and a consent decision never reached PostHog either way.
 */
export const syncConsentToPostHog = ({ preferences }: { preferences: Record<string, boolean> }): void => {
    if (preferences.measurement) {
        posthog.opt_in_capturing();
    } else {
        posthog.opt_out_capturing();
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
            capture_pageview: true,
            // PostHog will not set any cookies until the user has given consent
            cookieless_mode: "on_reject",
            loaded: (ph) => {
                // Avoid accidental tracking without consent until c15t has loaded
                if (ph.has_opted_out_capturing()) {
                    // PostHog is already opted out (default in cookieless_mode: 'on_reject')
                    // This ensures no tracking happens until consent is granted
                }

                if (import.meta.env && import.meta.env.DEV) {
                    // In development, opt in for debugging
                    ph.opt_in_capturing();
                    ph.debug();
                }
            },
            person_profiles: "always",
        });
    }, []);

    return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};

export default AnalyticsProvider;
